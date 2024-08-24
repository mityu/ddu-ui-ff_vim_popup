import {
  ActionFlags,
  as,
  assert,
  BaseActionParams,
  batch,
  BufferPreviewer,
  DduItem,
  type Denops,
  ensure,
  equal,
  fn,
  is,
  NoFilePreviewer,
  options,
  PredicateType,
  PreviewContext,
  Previewer,
  TerminalPreviewer,
  vimFn,
} from "../deps.ts";
import { invokeVimFunction } from "../util.ts";
import { Highlighter } from "../highlighter.ts";
import { Popup, PopupCreateArgs } from "./base.ts";
import { Params } from "../../ff_vim_popup.ts";

const isPreviewParams = is.ObjectOf({
  syntaxLimitChars: as.Optional(is.Number),
});

type PreviewParams = PredicateType<typeof isPreviewParams>;

export class PreviewPopup extends Popup {
  static readonly #propTypeName =
    "ddu-ui-ff_vim_popup-prop-type-preview-highlight";
  static readonly #isPopupPos = is.ObjectOf({
    core_col: is.Number,
    core_line: is.Number,
    core_width: is.Number,
    core_height: is.Number,
  });

  #previewedTarget?: DduItem;
  #highlighter?: Highlighter;
  #abortTerminalPreview?: (denops: Denops) => Promise<void>;

  async openWindow(denops: Denops, layout: PopupCreateArgs) {
    await super.open(denops, layout, []);
  }

  override async close(denops: Denops): Promise<void> {
    if (this.#abortTerminalPreview) {
      await this.#abortTerminalPreview(denops);
    }
    this.#previewedTarget = undefined;
    await super.close(denops);
  }

  async doPreview(
    denops: Denops,
    uiParams: Params,
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

    // Kill terminal previewer if exists.
    if (this.#abortTerminalPreview) {
      await this.#abortTerminalPreview(denops);
      this.#abortTerminalPreview = undefined;
    }

    // Clear previous highlight
    if (this.#highlighter) {
      await this.#highlighter.clearAll(denops);
      this.#highlighter = undefined;
    }

    assert(actionParams, isPreviewParams);

    const popupPos = ensure(
      await vimFn.popup_getpos(denops, this.getWinId()),
      PreviewPopup.#isPopupPos,
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
          item,
          previewContext,
        );
      } else if (previewer.kind === "nofile") {
        return await this.#previewContentsNofile(
          denops,
          previewer,
          uiParams,
          actionParams,
          item
        );
      } else {
        return await this.#previewContentsBuffer(
          denops,
          previewer,
          uiParams,
          actionParams,
          item,
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

  async #previewContentsNofile(
    denops: Denops,
    previewer: NoFilePreviewer,
    uiParams: Params,
    actionParams: PreviewParams,
    item: DduItem,
  ): Promise<ActionFlags> {
    if (previewer.contents.length === 0) {
      return ActionFlags.None;
    }

    const previewBuffer = await this.#getPreviewBuffer(denops, previewer, item);

    await this.setBuffer(denops, previewBuffer.bufnr);
    await this.setText(denops, previewer.contents);

    const limit = actionParams.syntaxLimitChars ?? 40000;
    if (
      previewer.contents.map((v) => v.length).reduce((x, y) => x + y) < limit
    ) {
      if (previewer.filetype) {
        await fn.setbufvar(
          denops,
          previewBuffer.bufnr,
          "&filetype",
          previewer.filetype,
        );
      }

      if (previewer.syntax) {
        await fn.setbufvar(
          denops,
          previewBuffer.bufnr,
          "&syntax",
          previewer.syntax,
        );
      }
    }

    await this.#highlight(
      denops,
      previewer,
      previewBuffer.bufnr,
      uiParams.highlights.previewline,
    );

    return ActionFlags.Persist;
  }

  // Handle buffer previewer and nofile previewer.
  async #previewContentsBuffer(
    denops: Denops,
    previewer: BufferPreviewer,
    uiParams: Params,
    actionParams: PreviewParams,
    item: DduItem,
  ): Promise<ActionFlags> {
    if (!(previewer.expr || previewer.path)) {
      return ActionFlags.None;
    }

    const isTerminal = previewer.expr
      ? (await fn.getbufvar(denops, previewer.expr, "&buftype") === "terminal")
      : false;
    const previewBuffer = await this.#getPreviewBuffer(denops, previewer, item);

    if (isTerminal) {
      const bufnr = is.Number(previewer.expr)
        ? previewer.expr
        : await fn.bufnr(denops, previewer.expr);
      await invokeVimFunction(
        denops,
        "ddu#ui#ff_vim_popup#term_previewer#ScrapeTerminal",
        bufnr,
        this.getWinId()!,
      );
      await this.#highlight(
        denops,
        previewer,
        previewBuffer.bufnr,
        uiParams.highlights.previewline,
      );
      return ActionFlags.Persist;
    }

    const [err, contents] = await this.#getContents(denops, previewer);

    await this.setBuffer(denops, previewBuffer.bufnr);
    await this.setText(denops, contents);

    const limit = actionParams.syntaxLimitChars ?? 400000;
    if (!err && contents.map((v) => v.length).reduce((x, y) => x + y) < limit) {
      if (previewer.filetype) {
        await fn.setbufvar(
          denops,
          previewBuffer.bufnr,
          "&filetype",
          previewer.filetype,
        );
      }

      if (previewer.syntax) {
        await fn.setbufvar(
          denops,
          previewBuffer.bufnr,
          "&syntax",
          previewer.syntax,
        );
      }

      const filetype = ensure(
        await fn.getbufvar(denops, previewBuffer.bufnr, "&filetype"),
        is.String,
      );
      const syntax = ensure(
        await fn.getbufvar(denops, previewBuffer.bufnr, "&syntax"),
        is.String,
      );
      if (syntax.length === 0 && filetype.length === 0) {
        await fn.win_execute(denops, this.getWinId(), "filetype detect");
      }
    }

    if (!err) {
      await this.#highlight(
        denops,
        previewer,
        previewBuffer.bufnr,
        uiParams.highlights.previewline,
      );
    }

    return ActionFlags.Persist;
  }

  // Handle terminal previewer.
  async #previewContentsTerminal(
    denops: Denops,
    previewer: TerminalPreviewer,
    item: DduItem,
    previewContext: PreviewContext,
  ): Promise<ActionFlags> {
    const previewBuffer = await this.#getPreviewBuffer(denops, previewer, item);
    await this.setBuffer(denops, previewBuffer.bufnr);

    const termBufnr = await denops.call(
      "ddu#ui#ff_vim_popup#term_previewer#DoPreview",
      this.getWinId()!,
      previewer.cmds,
      {
        cwd: previewer.cwd,
        term_rows: previewContext.height,
        term_cols: previewContext.width,
      },
    );

    this.#abortTerminalPreview = async (denops: Denops) => {
      await invokeVimFunction(
        denops,
        "ddu#ui#ff_vim_popup#term_previewer#StopPreview",
        termBufnr,
      );
    };

    return ActionFlags.Persist;
  }

  // Get bufname/bufnr for preview.  The buffer is created if necessary.
  async #getPreviewBuffer(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer | TerminalPreviewer,
    item: DduItem,
  ): Promise<{ bufname: string; bufnr: number }> {
    // Use existing buffer as the preview buffer.
    if (
      previewer.kind === "buffer" && previewer.expr && previewer.useExisting
    ) {
      if (is.String(previewer.expr)) {
        return {
          bufname: previewer.expr,
          bufnr: await fn.bufnr(denops, previewer.expr),
        };
      } else {
        return {
          bufname: await fn.bufname(denops, previewer.expr),
          bufnr: previewer.expr,
        };
      }
    }

    // Create new buffer for preview.
    const getNewBufferName = async (): Promise<string> => {
      const schema = "ddu-ff-vim-popup://";

      if (previewer.kind === "buffer") {
        if (previewer.expr) {
          const bufname = await fn.bufname(denops, previewer.expr);
          const buftype = ensure(
            await fn.getbufvar(denops, previewer.expr, "&buftype"),
            is.String,
          );
          if (buftype === "terminal") {
            return `${schema}preview`;
          } else if (bufname.length === 0) {
            return `${schema}no-name:${previewer.expr}`;
          } else {
            return `${schema}${bufname}`;
          }
        } else { // !previewer.expr
          return `${schema}${previewer.path}`;
        }
      } else if (previewer.kind === "nofile" || previewer.kind == "terminal") {
        return `${schema}preview`;
      } else {
        return `${schema}${item.word}`;
      }
    };

    const bufname = await getNewBufferName();
    const bufnr = await fn.bufnr(denops, bufname);
    if (bufnr !== -1) {
      return {
        bufname: bufname,
        bufnr: bufnr,
      };
    }

    const newBufnr = await fn.bufadd(denops, bufname);
    await batch(denops, async (denops: Denops) => {
      await fn.setbufvar(denops, newBufnr, "&buftype", "popup");
      await fn.setbufvar(denops, newBufnr, "&swapfile", 0);
      await fn.setbufvar(denops, newBufnr, "&backup", 0);
      await fn.setbufvar(denops, newBufnr, "&undofile", 0);
      await fn.setbufvar(denops, newBufnr, "&bufhidden", "hide");
      await fn.setbufvar(denops, newBufnr, "&modeline", 1);

      await fn.bufload(denops, newBufnr);
    });

    return {
      bufname: bufname,
      bufnr: newBufnr,
    };
  }

  async #getContents(
    denops: Denops,
    previewer: BufferPreviewer,
  ): Promise<[err: true | undefined, contents: string[]]> {
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
          "ddu#ui#ff_vim_popup#util#Search",
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
      await vimFn.popup_setoptions(denops, this.getWinId()!, {
        firstline: firstLine,
      });
    }
  }

  async #highlight(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    bufnr: number,
    hlName: string,
  ) {
    this.#highlighter = new Highlighter(this.getWinId()!, bufnr);

    if (previewer.lineNr) {
      const len = await options.columns.get(denops);
      await this.#highlighter.addProp(denops, {
        propTypeName: PreviewPopup.#propTypeName,
        highlight: hlName,
        line: previewer.lineNr,
        col: 1,
        len: len,
      });
    } else if (previewer.pattern) {
      await this.#highlighter.addMatch(denops, {
        pattern: previewer.pattern,
        highlight: hlName,
      });
    }

    if (previewer.highlights) {
      await batch(denops, async (denops: Denops) => {
        for (const hl of previewer.highlights!) {
          await this.#highlighter!.addProp(denops, {
            propTypeName: hl.name,
            highlight: hl.hl_group,
            line: hl.row,
            col: hl.col,
            len: hl.width,
          });
        }
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
