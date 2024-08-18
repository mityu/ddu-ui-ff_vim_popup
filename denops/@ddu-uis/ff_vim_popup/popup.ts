import {
  ActionFlags,
  BaseActionParams,
  BufferPreviewer,
  Context,
  DduItem,
  type Denops,
  ensure,
  equal,
  fn,
  is,
  lambda,
  NoFilePreviewer,
  PreviewContext,
  Previewer,
  TerminalPreviewer,
} from "./deps.ts";
import { Params } from "../ff_vim_popup.ts";
import { echomsgError, invokeVimFunction } from "./util.ts";

type UserCallback = (denops: Denops, winId: number) => Promise<void>;

export type PopupCreateArgs = {
  line: number;
  col: number;
  minwidth: number;
  maxwidth: number;
  minheight: number;
  maxheight: number;
  highlight: string;
  border: number[];
  borderchars: string[];
  wrap: false;
  scrollbar: false;
};

export class Popup {
  #winId?: number;
  #bufnr?: number;
  #userCallback?: UserCallback;
  #callback?: lambda.Lambda;

  exists(): boolean {
    return this.#winId !== undefined;
  }

  async open(
    denops: Denops,
    opts: PopupCreateArgs,
    callback?: UserCallback,
  ): Promise<void> {
    if (this.exists()) {
      await echomsgError(denops, "internal error: popup is already opened");
      return;
    }
    this.#userCallback = callback;
    this.#callback = lambda.add(denops, async (winId: unknown) => {
      this.#winId = undefined;
      if (this.#userCallback) {
        await this.#userCallback(denops, ensure(winId, is.Number));
      }
      if (this.#callback) {
        this.#callback.dispose();
      }
    });
    this.#winId = ensure(
      await denops.call("popup_create", "", opts),
      is.Number,
    );
    this.#bufnr = await fn.winbufnr(denops, this.#winId);
    await invokeVimFunction(
      denops,
      "ddu#ui#ff_vim_popup#internal#RegisterPopupCallback",
      this.#winId,
      denops.name,
      this.#callback.id,
    );
  }

  async close(denops: Denops): Promise<void> {
    if (this.exists()) {
      await denops.call("popup_close", this.#winId!);
    }
  }

  async setText(denops: Denops, text: string[]): Promise<void> {
    await denops.call("popup_settext", this.#winId!, text);
  }

  getWinId(): number | undefined {
    return this.#winId;
  }

  getBufnr(): number | undefined {
    return this.#bufnr;
  }

  async updateBufnr(denops: Denops) {
    if (this.exists()) {
      this.#bufnr = await fn.winbufnr(denops, this.#winId!);
    }
  }
}

export class PreviewPopup extends Popup {
  #previewedTarget?: DduItem;
  #isPopupPos = is.ObjectOf({
    core_col: is.Number,
    core_line: is.Number,
    core_width: is.Number,
    core_height: is.Number,
  });

  async doPreview(
    denops: Denops,
    actionParams: unknown,
    item: DduItem,
    getPreviewer?: (
      denops: Denops,
      item: DduItem,
      actionParams: BaseActionParams,
      previewContext: PreviewContext,
    ) => Promise<Previewer | undefined>,
  ): Promise<ActionFlags> {
    if (this.isAlreadyPreviewed(item) || !getPreviewer) {
      return ActionFlags.None;
    }
    const popupPos = ensure(
      await denops.call("popup_getpos", this.getWinId()),
      this.#isPopupPos,
    );
    const previewContext: PreviewContext = {
      col: popupPos.core_col,
      row: popupPos.core_line,
      width: popupPos.core_width,
      height: popupPos.core_height,
      isFloating: true,
      split: "no",
    };
    const previewer = await getPreviewer(
      denops,
      item,
      actionParams as BaseActionParams,
      previewContext,
    );
    if (!previewer) {
      return ActionFlags.None;
    }

    const flag = await (async (): Promise<ActionFlags> => {
      if (previewer.kind === "terminal") {
        return await this.#previewContentsTerminal(
          denops,
          previewer,
        );
      } else {
        return await this.#previewContentsBuffer(
          denops,
          previewer,
        );
      }
    })();
    if (flag === ActionFlags.None) {
      return flag;
    }

    this.#previewedTarget = item;

    await this.#jump(denops, previewer, previewContext);

    return ActionFlags.Persist;
  }

  async #previewContentsBuffer(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    // actionParams: PreviewParams,
  ): Promise<ActionFlags> {
    if (
      previewer.kind === "nofile" && !previewer.contents?.length ||
      previewer.kind === "buffer" && !previewer.expr && !previewer.path
    ) {
      return ActionFlags.None;
    }

    const previewBufnr = ensure(this.getBufnr(), is.Number);
    const [err, contents] = await this.#getContents(denops, previewer);

    await this.setText(denops, contents);

    // const limit = actionParams.syntaxLimitChars ?? 400000;
    const limit = 400000;
    if (!err && contents.join("\n").length < limit) {
      if (previewer.filetype) {
        await fn.setbufvar(
          denops,
          previewBufnr,
          "&filetype",
          previewer.filetype,
        );
      }

      if (previewer.syntax) {
        await fn.setbufvar(
          denops,
          previewBufnr,
          "&syntax",
          previewer.syntax,
        );
      }
      await fn.win_execute(denops, this.getWinId(), "filetype detect");
    }

    // TODO: Highlight target line. etc.
    // if (!err) {
    //   await this.#highlight(
    //     denops,
    //     previewer,
    //     previewBufnr,
    //     uiParams.highlights?.preview ?? "Search",
    //   );
    // }

    return ActionFlags.Persist;
  }

  async #previewContentsTerminal(
    denops: Denops,
    previewer: TerminalPreviewer,
  ): Promise<ActionFlags> {
    await this.setText(denops, ["Terminal previewer is not implemented yet."]);
    return ActionFlags.Persist;
  }

  async #getContents(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
  ): Promise<[err: true | undefined, contents: string[]]> {
    if (previewer.kind !== "buffer") {
      return [undefined, previewer.contents];
    }

    try {
      const bufferPath = previewer.expr ?? previewer.path;
      const stat = await getFileInfo(previewer.path);
      if (previewer.path && stat && !stat.isDirectory) {
        const data = Deno.readFileSync(previewer.path);
        const contents = new TextDecoder().decode(data).split("\n");
        return [undefined, contents];
      } else if (bufferPath && await fn.bufexists(denops, bufferPath)) {
        // Use buffer instead.
        const bufnr = await fn.bufnr(denops, bufferPath);
        await fn.bufload(denops, bufnr);
        const contents = await fn.getbufline(denops, bufnr, 1, "$");
        return [undefined, contents];
      } else {
        throw new Error(`"${previewer.path}" cannot be opened.`);
      }
    } catch (e: unknown) {
      const contents = [
        "Error",
        `${(e as Error)?.message ?? e}`,
      ];
      return [true, contents];
    }
  }

  async #jump(
    denops: Denops,
    previewer: Previewer,
    previewContext: PreviewContext,
  ) {
    const cursorLine = await (async () => {
      const hasLineNr = is.ObjectOf({ lineNr: is.Number });
      if (hasLineNr(previewer)) {
        return previewer.lineNr;
      }
      const hasPattern = is.ObjectOf({ pattern: is.String });
      if (hasPattern(previewer)) {
        const linenr = await denops.call(
          "ddu#ui#ff_vim_popup#Search",
          this.getWinId(),
          previewer.pattern,
        );
        return ensure(linenr, is.Number);
      }
      return undefined;
    })();
    if (cursorLine) {
      const firstLine = (() => {
        const line = cursorLine - Math.trunc(previewContext.height / 2);
        if (line >= 1) {
          return line;
        } else {
          return 1;
        }
      })();
      await denops.call("popup_setoptions", this.getWinId(), {
        firstline: firstLine,
      });
    }
  }

  isAlreadyPreviewed(item: DduItem): boolean {
    return equal(item, this.#previewedTarget);
  }
}

async function getFileInfo(path?: string): Promise<Deno.FileInfo | undefined> {
  if (!path) {
    return undefined;
  }

  try {
    return await Deno.stat(path);
  } catch (_: unknown) {
    // Ignore
  }
  return undefined;
}
