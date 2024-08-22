import {
  ActionFlags,
  ansiEscapeCode,
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
  itertools,
  lambda,
  NoFilePreviewer,
  options,
  pipe,
  PredicateType,
  PreviewContext,
  Previewer,
  TerminalPreviewer,
  vars,
  vimFn,
} from "./deps.ts";
import { echomsgError, invokeVimFunction, strBytesLength } from "./util.ts";
import { Highlighter } from "./highlighter.ts";
import { CommandOptions, Executor } from "./executor.ts";
import { Params } from "../ff_vim_popup.ts";

const propTypeName = "ddu-ui-ff_vim_popup-prop-type-preview-highlight";

const isPreviewParams = is.ObjectOf({
  syntaxLimitChars: as.Optional(is.Number),
});

type PreviewParams = PredicateType<typeof isPreviewParams>;

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
  #highlight?: string;
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
    this.#highlight = opts.highlight;
    this.#callback = lambda.add(denops, async (winId: unknown) => {
      this.#winId = undefined;
      this.#bufnr = undefined;
      this.#highlight = undefined;
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

  async setBuffer(denops: Denops, bufnr: number): Promise<void> {
    await batch(denops, async (denops: Denops) => {
      await denops.call("popup_setbuf", this.#winId!, bufnr);
      await denops.call("popup_setoptions", this.#winId!, {
        highlight: this.#highlight!,
      });
    });
    this.#bufnr = bufnr;
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
  static readonly #isPopupPos = is.ObjectOf({
    core_col: is.Number,
    core_line: is.Number,
    core_width: is.Number,
    core_height: is.Number,
  });
  #previewedTarget?: DduItem;
  #highlighter?: Highlighter;
  #terminalPreviewDrawer: TerminalPreviewDrawer;
  #terminalPreviewExecutor?: Executor;

  constructor() {
    super();
    this.#terminalPreviewDrawer = new TerminalPreviewDrawer(this);
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
    if (this.#terminalPreviewExecutor) {
      await this.#terminalPreviewExecutor.abort(denops);
      this.#terminalPreviewExecutor = undefined;
    }

    assert(actionParams, isPreviewParams);

    const popupPos = ensure(
      await denops.call("popup_getpos", this.getWinId()),
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

  getHighlighter(): Highlighter | undefined {
    return this.#highlighter;
  }

  // Handle buffer previewer and nofile previewer.
  async #previewContentsBuffer(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    uiParams: Params,
    actionParams: PreviewParams,
    item: DduItem,
  ): Promise<ActionFlags> {
    if (
      previewer.kind === "nofile" && !previewer.contents?.length ||
      previewer.kind === "buffer" && !previewer.expr && !previewer.path
    ) {
      return ActionFlags.None;
    }

    const previewBuffer = await this.#getPreviewBuffer(denops, previewer, item);
    const [err, contents] = await this.#getContents(denops, previewer);

    await this.setBuffer(denops, previewBuffer.bufnr);
    await this.setText(denops, contents);

    const limit = actionParams.syntaxLimitChars ?? 400000;
    if (!err && contents.join("\n").length < limit) {
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
        uiParams.highlights.preview,
      );
    }

    return ActionFlags.Persist;
  }

  // Handle terminal previewer.
  async #previewContentsTerminal(
    denops: Denops,
    previewer: TerminalPreviewer,
    item: DduItem,
  ): Promise<ActionFlags> {
    if (this.#highlighter) {
      await this.#highlighter.clearAll(denops);
      this.#highlighter = undefined;
    }

    this.#terminalPreviewDrawer.clear();
    await this.#terminalPreviewDrawer.prepare(denops);

    const previewBuffer = await this.#getPreviewBuffer(denops, previewer, item);
    await this.setBuffer(denops, previewBuffer.bufnr);

    this.#highlighter = new Highlighter(this.getWinId()!, previewBuffer.bufnr);

    const opts: CommandOptions = {
      out_cb: async (msg: string) => {
        this.#terminalPreviewDrawer.addStdout(msg);
        await this.#terminalPreviewDrawer.showWithoutDecorations(
          denops,
          this.#highlighter!,
        );
      },
      err_cb: async (msg: string) => {
        this.#terminalPreviewDrawer.addStderr(msg);
        await this.#terminalPreviewDrawer.showWithoutDecorations(
          denops,
          this.#highlighter!,
        );
      },
      close_cb: async () => {
        await this.#terminalPreviewDrawer.showWithDecorations(
          denops,
          this.#highlighter!,
        );
        this.#terminalPreviewExecutor = undefined;
      },
    };
    if (previewer.cwd) {
      opts.cwd = previewer.cwd;
    }
    this.#terminalPreviewExecutor = new Executor(previewer.cmds, opts);
    await this.#terminalPreviewExecutor.spawn(denops);

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
          if (bufname.length === 0) {
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

  async #highlight(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    bufnr: number,
    hlName: string,
  ) {
    if (this.#highlighter) {
      await this.#highlighter.clearAll(denops);
      this.#highlighter = undefined;
    }

    this.#highlighter = new Highlighter(this.getWinId()!, bufnr);

    if (previewer.lineNr) {
      const len = await options.columns.get(denops);
      await this.#highlighter.addProp(denops, {
        propTypeName: propTypeName,
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

type HighlightDictAttr = {
  bold: boolean;
  inverse: boolean;
  italic: boolean;
  strike: boolean;
  underline: boolean;
};

type HighlightDict = {
  name: string;
  term: HighlightDictAttr;
  cterm: HighlightDictAttr;
  gui: HighlightDictAttr;
  ctermfg?: string;
  ctermbg?: string;
  guifg?: string;
  guibg?: string;
  force: true;
};

class DecoratedBuffer {
  lines: string[];
  decorations: {
    line: number;
    col: number;
    len: number;
    highlight: string;
  }[];
  highlights: Map<string, HighlightDict>;
  #terminalAnsiColors?: string[];

  constructor() {
    this.lines = [];
    this.decorations = [];
    this.highlights = new Map();
  }

  setTerminalAnsiColors(colors: string[]) {
    this.#terminalAnsiColors = colors;
  }

  addLine(line: string) {
    const [text, annons] = ansiEscapeCode.trimAndParse(line);
    this.lines.push(text);

    // Build decoration information.
    const linenr = this.lines.length;
    const decos = pipe(
      annons,
      (annons) => {
        return annons.map((annon) => {
          return {
            offset: strBytesLength(text.substring(0, annon.offset)),
            sgr: annon.csi.sgr,
          };
        });
      },
      (annons) => {
        annons.push({ offset: strBytesLength(text), sgr: undefined });
        return annons;
      },
      (annons) => {
        const decos = [];
        for (const [cur, next] of itertools.pairwise(annons)) {
          if (cur.sgr) {
            const highlight = this.#getHighlightName(cur.sgr);
            if (highlight) {
              decos.push({
                line: linenr,
                col: cur.offset + 1,
                len: next.offset - cur.offset,
                highlight: highlight,
              });
              if (!this.highlights.has(highlight)) {
                this.highlights.set(
                  highlight,
                  this.#getHighlightDict(highlight, cur.sgr),
                );
              }
            }
          }
        }
        return decos;
      },
      (decos) => decos.filter((v) => v),
    );
    this.decorations.push(...decos);
  }

  clear() {
    this.lines = [];
    this.decorations = [];
    this.#terminalAnsiColors = undefined;
  }

  #getHighlightName(sgr: ansiEscapeCode.Sgr): string | undefined {
    if (sgr.reset) {
      return undefined;
    }

    const attr = [
      sgr.foreground ? `F${this.#formatColor(sgr.foreground)}` : "",
      sgr.background ? `F${this.#formatColor(sgr.background)}` : "",
      sgr.bold ? "Bold" : "",
      sgr.inverse ? "Inverse" : "",
      sgr.italic ? "Italic" : "",
      sgr.strike ? "Strike" : "",
      sgr.underline ? "Underline" : "",
    ];
    if (attr.length === 0) {
      return undefined;
    }
    return `DduFfVimPopupTermPreview${attr.join("")}`;
  }

  #getHighlightDict(name: string, sgr: ansiEscapeCode.Sgr): HighlightDict {
    const toBoolean = (x: boolean | unknown): boolean => {
      return x ? true : false;
    };
    const attrs = {
      bold: toBoolean(sgr.bold),
      inverse: toBoolean(sgr.inverse),
      italic: toBoolean(sgr.italic),
      strike: toBoolean(sgr.strike),
      underline: toBoolean(sgr.underline),
    };

    const getFg = (c: ansiEscapeCode.Color | undefined) => {
      if (c == null || c === "default") {
        return {};
      } else if (is.Number(c)) {
        return {
          ctermfg: c.toString(),
          guifg: this.#terminalAnsiColors![c],
        };
      } else {
        return {
          guifg: `#${this.#formatColor(c)}`,
        };
      }
    };

    const getBg = (c: ansiEscapeCode.Color | undefined) => {
      if (c == null || c === "default") {
        return {};
      } else if (is.Number(c)) {
        return {
          ctermbg: c.toString(),
          guibg: this.#terminalAnsiColors![c],
        };
      } else {
        return {
          guibg: `#${this.#formatColor(c)}`,
        };
      }
    };

    return {
      name: name,
      force: true,
      term: attrs,
      cterm: attrs,
      gui: attrs,
      ...getFg(sgr.foreground),
      ...getBg(sgr.background),
    };
  }

  #formatColor(c: ansiEscapeCode.Color): string {
    if (c === "default") {
      return "";
    } else if (is.Number(c)) {
      return c.toString();
    } else {
      return c.map((v) => v.toString(16).padStart(2, "0")).join("");
    }
  }
}

class TerminalPreviewDrawer {
  static readonly propTypeName =
    "ddu-ui-ff-vim-popup-terminal-previewer-drawer-stderr-region";
  #popup: PreviewPopup;
  #stdout: DecoratedBuffer;
  #stderr: DecoratedBuffer;

  constructor(popup: PreviewPopup) {
    this.#popup = popup;
    this.#stdout = new DecoratedBuffer();
    this.#stderr = new DecoratedBuffer();
  }

  clear() {
    this.#stdout.clear();
    this.#stderr.clear();
  }

  async prepare(denops: Denops) {
    const colors = await this.#getTerminalAnsiColors(denops);
    this.#stdout.setTerminalAnsiColors(colors);
    this.#stderr.setTerminalAnsiColors(colors);
  }

  addStdout(msg: string) {
    msg.split(/\r?\n/).forEach((line) => this.#stdout.addLine(line));
  }

  addStderr(msg: string) {
    msg.split(/\r?\n/).forEach((line) => this.#stderr.addLine(line));
  }

  async showWithoutDecorations(
    denops: Denops,
    highlighter: Highlighter,
  ): Promise<void> {
    await this.#popup.setText(denops, this.#getLines());
    if (this.#stderr.lines.length !== 0) {
      await batch(denops, async (denops) => {
        const lens = this.#stderr.lines.map((line) => strBytesLength(line));
        for (const [i, len] of itertools.enumerate(lens)) {
          await highlighter.addProp(denops, {
            propTypeName: TerminalPreviewDrawer.propTypeName,
            highlight: "Error",
            line: i + 1,
            col: 0,
            len: len,
          });
        }
      });
    }
  }

  async showWithDecorations(
    denops: Denops,
    highlighter: Highlighter,
  ): Promise<void> {
    await this.showWithoutDecorations(denops, highlighter);

    if (this.#stdout.highlights.size !== 0) {
      await vimFn.hlset(denops, Array.from(this.#stdout.highlights.values()));
    }

    if (this.#stderr.lines.length !== 0) {
      // Show stderr and stdout.
      if (this.#stderr.highlights.size !== 0) {
        await vimFn.hlset(denops, Array.from(this.#stderr.highlights.values()));
      }

      const lineOffset = this.#stderr.lines.length + 1;
      const stdoutDecos = this.#stdout.decorations.map((deco) => {
        return {
          ...deco,
          line: deco.line + lineOffset,
        };
      });

      const decos = itertools.chain(this.#stderr.decorations, stdoutDecos);

      for (const deco of decos) {
        await highlighter.addProp(denops, {
          ...deco,
          propTypeName: TerminalPreviewDrawer.propTypeName,
        });
      }
    } else {
      // Show only stdout
      for (const deco of this.#stdout.decorations) {
        // NOTE: Using batch() here doesn't work well because prop_type_get
        // after prop_type_add doesn't return proper result if batched.
        await highlighter.addProp(denops, {
          ...deco,
          propTypeName: `prop-type-${deco.highlight}`,
        });
      }
    }
  }

  #getLines(): string[] {
    if (this.#stderr.lines.length === 0) {
      return this.#stdout.lines;
    } else {
      return [...this.#stderr.lines, "", ...this.#stdout.lines];
    }
  }

  async #getTerminalAnsiColors(denops: Denops): Promise<string[]> {
    const colors = ensure(
      await vars.g.get(denops, "terminal_ansi_colors", undefined),
      as.Optional(is.ArrayOf(is.String)),
    );
    if (colors !== undefined && colors.length !== 0) {
      return colors;
    }
    return [
      "black",
      "darkred",
      "darkgreen",
      "brown",
      "darkblue",
      "darkmagenta",
      "darkcyan",
      "lightgrey",
      "darkgrey",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
    ];
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
