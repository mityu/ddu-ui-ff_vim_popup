import {
  ActionFlags,
  BaseUi,
  Context,
  DduItem,
  DduOptions,
  ItemHighlight,
  UiActions,
  UiOptions,
} from "https://deno.land/x/ddu_vim@v4.0.0/types.ts";
import {
  batch,
  Denops,
  equal,
  fn,
  vars,
} from "https://deno.land/x/ddu_vim@v4.0.0/deps.ts";
import {
  assert,
  ensure,
  is,
  PredicateType,
} from "https://deno.land/x/unknownutil@v3.18.0/mod.ts";
import { Popup, PopupCreateArgs } from "./ff_vim_popup/popup.ts";
import { invokeVimFunction, strBytesLength } from "./ff_vim_popup/util.ts";
import {
  LineBuffer,
  LineBufferDisplay,
  LineBufferHistory,
} from "./ff_vim_popup/linebuffer.ts";

const propTypeName = "ddu-ui-ff_vim_popup-prop-type-cursor";

const isActionParamCount1 = is.ObjectOf({
  count1: is.OptionalOf(is.Number),
});

const isSign = is.ObjectOf({
  name: is.String,
  group: is.String,
  id: is.OptionalOf(is.Number),
});
type Sign = PredicateType<typeof isSign>;

type DoActionParams = {
  name?: string;
  items?: DduItem[];
  params?: unknown;
};

const isBounds = is.ObjectOf({
  line: is.Number,
  col: is.Number,
  width: is.Number,
  height: is.Number,
});
export type Bounds = PredicateType<typeof isBounds>;

const isLayoutParams = is.ObjectOf({
  finder: isBounds,
  preview: isBounds,
});
export type LayoutParams = PredicateType<typeof isLayoutParams>;
export type LayoutParamsProvider = () => Promise<LayoutParams>;

type Layout = {
  lister: PopupCreateArgs;
  filter: PopupCreateArgs;
  preview: PopupCreateArgs;
};

export type Border = {
  mask: number[];
  chars: string[];
};

export type Params = {
  bounds: LayoutParams | LayoutParamsProvider | string;
  listerBorder: Border;
  filterBorder: Border;
  previewBorder: Border;
  filterPosition: "top" | "bottom";
  highlights: {
    popup: string;
    cursor: string;
    cursorline: string;
    selected: string;
  };
  reversed: boolean;
  hideCursor: boolean;
  prompt: string;
  handleCtrlC: boolean;
};

function pick<T, K extends keyof T>(
  obj: T,
  keys: K[],
): Pick<T, K> {
  return keys.reduce((acc, k) => ({ ...acc, [k]: obj[k] }), {}) as Pick<
    T,
    K
  >;
}

function moveCursorline(
  cursorItem: number,
  firstDisplayItem: number,
  delta: number,
  context: {
    itemCount: number;
    scrolloff: number;
    displayItemCount: number;
  },
): { cursorItem: number; firstDisplayItem: number } {
  if (context.displayItemCount === 0) {
    return {
      cursorItem: 0,
      firstDisplayItem: 0,
    };
  } else if (delta > 0) {
    const newCursorItem = cursorItem + delta;
    if (newCursorItem >= context.itemCount) {
      const newDelta = newCursorItem - context.itemCount;
      return moveCursorline(0, 0, newDelta, context);
    } else if (
      newCursorItem + context.scrolloff <=
        firstDisplayItem + context.displayItemCount - 1
    ) {
      return {
        cursorItem: cursorItem + delta,
        firstDisplayItem: firstDisplayItem,
      };
    } else {
      const newCursorItem = cursorItem + delta;
      return {
        cursorItem: newCursorItem,
        firstDisplayItem: Math.min(
          newCursorItem + context.scrolloff - (context.displayItemCount - 1),
          context.itemCount - context.displayItemCount,
        ),
      };
    }
  } else {
    const newCursorItem = cursorItem + delta;
    if (newCursorItem < 0) {
      return moveCursorline(
        context.itemCount - 1,
        context.itemCount - context.displayItemCount,
        newCursorItem + 1,
        context,
      );
    } else if (newCursorItem - context.scrolloff >= firstDisplayItem) {
      return {
        cursorItem: newCursorItem,
        firstDisplayItem: firstDisplayItem,
      };
    } else {
      return {
        cursorItem: newCursorItem,
        firstDisplayItem: Math.max(newCursorItem - context.scrolloff, 0),
      };
    }
  }
}

async function calcLayout(
  denops: Denops,
  uiParams: Params,
): Promise<Layout> {
  const normalizeBorder = (l: number[]) => l.map((v) => v === 0 ? 0 : 1);

  const isFilterTop = uiParams.filterPosition === "top";
  const bounds = await (async (): LayoutParams => {
    if (typeof uiParams.bounds === "function") {
      // TypeScript function.  Just call it.
      return await uiParams.bounds(denops);
    } else if (typeof uiParams.bounds === "string") {
      // Vim script function is given.  It must be a function-id produced by
      // denops#callback#register().
      return ensure(
        await denops.call("denops#callback#call", uiParams.bounds),
        isLayoutParams,
      );
    } else {
      return uiParams.bounds;
    }
  })();

  const previewBorder = normalizeBorder(uiParams.previewBorder.mask);
  const previewArgs: PopupCreateArgs = {
    line: bounds.preview.line + 1,
    col: bounds.preview.col + 1,
    minwidth: bounds.preview.width - 2,
    maxwidth: bounds.preview.width - 2,
    minheight: bounds.preview.height - 2,
    maxheight: bounds.preview.height - 2,
    highlight: uiParams.highlights.popup,
    border: previewBorder,
    borderchars: uiParams.previewBorder.chars,
    wrap: false,
    scrollbar: false,
  };

  const filterBorder = normalizeBorder(uiParams.filterBorder.mask);
  const filterArgs: PopupCreateArgs = {
    line: bounds.finder.line +
      (isFilterTop
        ? filterBorder[0]
        : bounds.finder.height - (filterBorder[0] + filterBorder[2])),
    col: bounds.finder.col + filterBorder[3],
    minwidth: bounds.finder.width - (filterBorder[1] + filterBorder[3]),
    maxwidth: bounds.finder.width - (filterBorder[1] + filterBorder[3]),
    minheight: 1,
    maxheight: 1,
    highlight: uiParams.highlights.popup,
    border: filterBorder,
    borderchars: uiParams.filterBorder.chars,
    wrap: false,
    scrollbar: false,
  };

  const filterHeight = 1 + filterBorder[0] + filterBorder[2];
  const listerBorder = normalizeBorder(uiParams.listerBorder.mask);
  const listerArgs: PopupCreateArgs = {
    line: bounds.finder.line + listerBorder[0] +
      (isFilterTop ? filterHeight : 0),
    col: bounds.finder.col + listerBorder[3],
    minwidth: bounds.finder.width - (listerBorder[1] + listerBorder[3]),
    maxwidth: bounds.finder.width - (listerBorder[1] + listerBorder[3]),
    minheight: bounds.finder.height - filterHeight -
      (listerBorder[0] + listerBorder[2]),
    maxheight: bounds.finder.height - filterHeight -
      (listerBorder[0] + listerBorder[2]),
    highlight: uiParams.highlights.popup,
    border: listerBorder,
    borderchars: uiParams.listerBorder.chars,
    wrap: false,
    scrollbar: false,
  };

  return {
    lister: listerArgs,
    filter: filterArgs,
    preview: previewArgs,
  };
}

export class Ui extends BaseUi<Params> {
  #items: DduItem[] = [];
  #selectedItems: Set<number> = new Set();
  #maxDisplayItemLength: number = 0;
  #firstDisplayItem: number = 0;
  #cursorItem: number = 0;
  #uiStateId?: number;
  #scrolloff: number = 0;
  #listerPopup: Popup = new Popup();
  #filterPopup: Popup = new Popup();
  #previewPopup: Popup = new Popup();
  #signCursorline?: Sign;
  #lineBuffer: LineBuffer = new LineBuffer();
  #lineBufferDisplay: LineBufferDisplay = new LineBufferDisplay();
  #lineBufferHistory: LineBufferHistory = new LineBufferHistory();
  #uiName?: string;

  override async onInit(
    args: { denops: Denops; uiParams: Params },
  ): Promise<void> {
    this.#scrolloff = await vars.go.get(args.denops, "scrolloff");
    this.#lineBufferHistory.push(this.#lineBuffer); // Push the initial state to the history.
  }

  override async onBeforeAction(): Promise<void> {
  }

  override async onAfterAction(): Promise<void> {
  }

  override refreshItems(args: {
    denops: Denops;
    items: DduItem[];
  }): Promise<void> {
    this.#items = args.items;
    this.#selectedItems.clear();
    this.#firstDisplayItem = 0;
    this.#cursorItem = 0;

    return Promise.resolve();
  }

  override collapseItem() {
    return Promise.resolve(0); // TODO:
  }

  override expandItem() {
    return Promise.resolve(0); // TODO:
  }

  override async searchItem(args: {
    denops: Denops;
    item: DduItem;
    uiParams: Params;
  }) {
    const idx = this.#items.findIndex((item) => equal(item, args.item));

    if (idx > 0) {
      const { cursorItem, firstDisplayItem } = moveCursorline(0, 0, idx, {
        itemCount: this.#items.length,
        scrolloff: this.#scrolloff,
        displayItemCount: Math.min(
          this.#maxDisplayItemLength,
          this.#items.length,
        ),
      });
      this.#cursorItem = cursorItem;
      this.#firstDisplayItem = firstDisplayItem;
      await this.#updateDisplayItems(args.denops, {
        reversed: args.uiParams.reversed,
        hl_selected: args.uiParams.highlights.selected,
      });
      await this.#updateCursorline(args.denops, args.uiParams.reversed);
    }
  }

  override async redraw(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<void> {
    if (args.options.sync && !args.context.done) {
      // Skip redraw if all items are not done
      return;
    }

    if (!this.visible()) {
      await this.#openWindows(args);
    }

    // TODO: Set preview contents, etc.
    await this.#updateDisplayItems(args.denops, {
      reversed: args.uiParams.reversed,
      hl_selected: args.uiParams.highlights.selected,
    });
    await this.#updateCursorline(args.denops, args.uiParams.reversed);
  }

  override async quit(args: { denops: Denops }) {
    await this.#filterPopup.close(args.denops); // This is enough to close the all popups.
  }

  override visible(): boolean {
    return this.#filterPopup.exists();
  }

  override winIds(): number[] {
    return [
      this.#listerPopup,
      this.#filterPopup,
      this.#previewPopup,
    ].filter((v) => v.exists()).map((v) => v.getWinId()!);
  }

  override async #openWindows(args: {
    denops: Denops;
    options: DduOptions;
    uiParams: Params;
  }): Promise<void> {
    const layout = await calcLayout(args.denops, args.uiParams);
    this.#maxDisplayItemLength = layout.lister.maxheight;
    this.#lineBufferDisplay.setMaxDisplayWidth(layout.filter.maxwidth);
    await this.#lineBufferDisplay.setPromptText(
      args.denops,
      args.uiParams.prompt,
    );

    this.#uiStateId = await args.denops.call(
      "ddu#ui#ff_vim_popup#internal#CreateNewUiState",
      pick(args.uiParams, ["hideCursor"]),
    ) as number;

    this.#signCursorline = {
      name: `ddu-ui-ff_vim_popup-cursorline-${this.#uiStateId}`,
      group: "PopUpDduUiFFVimPopupCursorline",
    };

    await this.#previewPopup.open(args.denops, layout.preview);
    await this.#filterPopup.open(
      args.denops,
      layout.filter,
      async (denops: Denops, _: number) =>
        // This may should be "quit" action of ddu.vim
        await this.#onClose(denops),
    );
    await this.#listerPopup.open(args.denops, layout.lister);

    await invokeVimFunction(
      args.denops,
      "ddu#ui#ff_vim_popup#internal#SetupKeyHandling",
      this.#uiStateId,
      this.#filterPopup.getWinId(),
    );

    const uiName = args.options.name ?? "default";
    this.#uiName = uiName;
    await batch(args.denops, async (denops) => {
      await fn.setbufvar(
        denops,
        this.#filterPopup.getBufnr()!,
        "ddu_ui_name",
        uiName,
      );
      await fn.setwinvar(
        denops,
        this.#listerPopup.getWinId()!,
        "&signcolumn",
        "yes",
      );
      await fn.sign_define(denops, this.#signCursorline!.name, {
        linehl: args.uiParams.highlights.cursorline,
        text: ">",
      });

      await denops.call("prop_type_add", propTypeName, {
        highlight: args.uiParams.highlights.cursor,
        bufnr: this.#filterPopup.getBufnr(),
      });
    });
    await this.#updatePrompt(args.denops);
  }

  async #onClose(denops: Denops) {
    if (!this.#uiStateId) {
      // Closing process is already done.
      return;
    }

    const uiStateId = this.#uiStateId;
    const signName = this.#signCursorline?.name;

    this.#uiStateId = undefined;
    this.#signCursorline = undefined;
    this.#selectedItems.clear();
    this.#lineBuffer = new LineBuffer(); // Clear inputs.
    this.#lineBufferDisplay = new LineBufferDisplay();
    this.#lineBufferHistory = new LineBufferHistory();

    await batch(denops, async (denops) => {
      await this.#listerPopup.close(denops);
      await this.#filterPopup.close(denops);
      await this.#previewPopup.close(denops);

      if (uiStateId) {
        await invokeVimFunction(
          denops,
          "ddu#ui#ff_vim_popup#internal#RemoveUiState",
          uiStateId,
        );
      }

      if (signName) {
        await fn.sign_undefine(denops, signName);
      }
    });
  }

  async #updateDisplayItems(
    denops: Denops,
    context: { hl_selected: string; reversed: boolean },
  ) {
    const displayItems = (() => {
      const items = this.#items.slice(
        this.#firstDisplayItem,
        this.#firstDisplayItem + this.#maxDisplayItemLength,
      );
      if (context.reversed) {
        return items.reverse();
      } else {
        return items;
      }
    })();
    const itemTexts = displayItems.map((v: DduItem): string => {
      return v.display ?? v.word;
    });
    const itemHighlights = displayItems.flatMap((v: DduItem, index: number) => {
      const linenr = index + 1;
      if (this.#selectedItems.has(this.#firstDisplayItem + index)) {
        return [{
          name: "ddu-ui-selected",
          hl_group: context.hl_selected,
          line: linenr,
          col: 1,
          width: strBytesLength(itemTexts[this.#firstDisplayItem + index]),
        }];
      } else if (v.highlights) {
        return v.highlights.map((v: ItemHighlight) => {
          return {
            name: v.name,
            hl_group: v.hl_group,
            line: linenr,
            col: v.col,
            width: v.width,
          };
        });
      } else {
        return [];
      }
    });
    await invokeVimFunction(
      denops,
      "ddu#ui#ff_vim_popup#internal#SetItems",
      this.#listerPopup.getWinId(),
      itemTexts,
      itemHighlights,
    );
  }

  async #updateCursorline(denops: Denops, reversed: boolean) {
    const getCursorline = () => {
      const cursorIdx = this.#cursorItem - this.#firstDisplayItem;
      if (reversed) {
        return this.#maxDisplayItemLength - cursorIdx - 1;
      } else {
        return cursorIdx + 1;
      }
    };

    assert(this.#signCursorline, isSign);

    if (this.#signCursorline.id) {
      await fn.sign_unplace(denops, this.#signCursorline.group, {
        buffer: this.#listerPopup.getBufnr(),
        id: this.#signCursorline.id,
      });
      this.#signCursorline.id = undefined;
    }

    const signId = await fn.sign_place(
      denops,
      0,
      this.#signCursorline.group,
      this.#signCursorline.name,
      this.#listerPopup.getBufnr()!,
      { lnum: getCursorline() },
    );
    if (signId != -1) {
      this.#signCursorline.id = signId;
    }
  }

  async #updatePrompt(denops: Denops) {
    const mode = ensure(
      await denops.call(
        "ddu#ui#ff_vim_popup#internal#CallKeymapperMethod",
        this.#uiStateId,
        "get_mode",
      ),
      is.String,
    );
    await this.#lineBufferDisplay.updateDisplay(denops, this.#lineBuffer);
    if (mode === "n") {
      await batch(denops, async (denops) => {
        await denops.call(
          "popup_settext",
          this.#filterPopup.getWinId(),
          this.#lineBufferDisplay.getDisplay().text,
        );
        await denops.call("prop_clear", 1, 1, {
          bufnr: this.#filterPopup.getBufnr(),
        });
      });
    } else {
      const display = this.#lineBufferDisplay.getDisplay();
      const byteColumn = display.byteColumn + 1; // Make 1-indexed.
      const bufnr = this.#filterPopup.getBufnr();
      await batch(denops, async (denops) => {
        await denops.call(
          "popup_settext",
          this.#filterPopup.getWinId(),
          display.text,
        );
        await denops.call("prop_clear", 1, 1, { bufnr: bufnr });
        if (display.charColumn < display.text.length) {
          await denops.call("prop_add", 1, byteColumn, {
            type: propTypeName,
            length: 1,
            bufnr: bufnr,
          });
        } else {
          await denops.call("prop_add", 1, 0, {
            type: propTypeName,
            text: " ",
            bufnr: bufnr,
          });
        }
      });
    }
  }

  async #notifyPromptChanges(denops: Denops) {
    // TODO: Debounce?
    await denops.dispatch("ddu", "redraw", this.#uiName!, {
      input: this.#lineBuffer.text,
    });
  }

  #getItemsForAction(): DduItem[] {
    if (this.#items.length === 0) {
      return [];
    }
    if (this.#selectedItems.size === 0) {
      return [this.#items[this.#cursorItem]];
    } else {
      return Array.from(this.#selectedItems.values()).map((v) => {
        return this.#items[v];
      });
    }
  }

  override actions: UiActions<Params> = {
    quit: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      await this.#onClose(args.denops);
      await args.denops.dispatcher.pop(args.options.name);
      return ActionFlags.None;
    },
    selectUpperItem: async (
      args: { denops: Denops; uiParams: Params; actionParams: unknown },
    ) => {
      const { count1 = 1 } = ensure(args.actionParams, isActionParamCount1);
      const { firstDisplayItem, cursorItem } = moveCursorline(
        this.#cursorItem,
        this.#firstDisplayItem,
        args.uiParams.reversed ? count1 : -count1,
        {
          itemCount: this.#items.length,
          scrolloff: this.#scrolloff,
          displayItemCount: Math.min(
            this.#maxDisplayItemLength,
            this.#items.length,
          ),
        },
      );

      if (this.#firstDisplayItem !== firstDisplayItem) {
        this.#firstDisplayItem = firstDisplayItem;
        this.#cursorItem = cursorItem;
        await this.#updateDisplayItems(args.denops, {
          reversed: args.uiParams.reversed,
          hl_selected: args.uiParams.highlights.selected,
        });
        await this.#updateCursorline(args.denops, args.uiParams.reversed);
      } else if (this.#cursorItem !== cursorItem) {
        this.#cursorItem = cursorItem;
        await this.#updateCursorline(args.denops, args.uiParams.reversed);
      }

      return ActionFlags.Persist;
    },
    selectLowerItem: async (
      args: { denops: Denops; uiParams: Params; actionParams: unknown },
    ) => {
      const { count1 = 1 } = ensure(args.actionParams, isActionParamCount1);
      const { firstDisplayItem, cursorItem } = moveCursorline(
        this.#cursorItem,
        this.#firstDisplayItem,
        args.uiParams.reversed ? -count1 : count1,
        {
          itemCount: this.#items.length,
          scrolloff: this.#scrolloff,
          displayItemCount: Math.min(
            this.#maxDisplayItemLength,
            this.#items.length,
          ),
        },
      );

      if (this.#firstDisplayItem !== firstDisplayItem) {
        this.#firstDisplayItem = firstDisplayItem;
        this.#cursorItem = cursorItem;
        await this.#updateDisplayItems(args.denops, {
          reversed: args.uiParams.reversed,
          hl_selected: args.uiParams.highlights.selected,
        });
        await this.#updateCursorline(args.denops, args.uiParams.reversed);
      } else if (this.#cursorItem !== cursorItem) {
        this.#cursorItem = cursorItem;
        await this.#updateCursorline(args.denops, args.uiParams.reversed);
      }

      return ActionFlags.Persist;
    },
    itemAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const params = args.actionParams as DoActionParams;
      const items = params.items ?? this.#getItemsForAction();

      if (items.length === 0) {
        return ActionFlags.Persist;
      }

      await args.denops.call(
        "ddu#item_action",
        args.options.name,
        params.name ?? "default",
        items,
        params.params ?? {},
      );

      return ActionFlags.None;
    },
    toggleSelectItem: () => {
      if (this.#items.length === 0) {
        return ActionFlags.None;
      }

      if (this.#selectedItems.has(this.#cursorItem)) {
        this.#selectedItems.delete(this.#cursorItem);
      } else {
        this.#selectedItems.add(this.#cursorItem);
      }
      return ActionFlags.Redraw;
    },
    toggleAllItems: () => {
      const s = new Set([...Array(this.#items.length).keys()]);
      this.#selectedItems = s.difference(this.#selectedItems);
      return ActionFlags.Redraw;
    },
    clearSelectAllItems: () => {
      this.#selectedItems.clear();
      return Promise.resolve(ActionFlags.Redraw);
    },
    moveToInsertMode: async (args: { denops: Denops }) => {
      await invokeVimFunction(
        args.denops,
        "ddu#ui#ff_vim_popup#internal#CallKeymapperMethod",
        this.#uiStateId,
        "set_mode",
        "i",
      );
      await this.#updatePrompt(args.denops);
      return ActionFlags.Persist;
    },
    undoInput: async (args: { denops: Denops }) => {
      const buf = this.#lineBufferHistory.prev();
      if (buf) {
        this.#lineBuffer = buf;
        await this.#lineBufferDisplay.updateDisplay(
          args.denops,
          this.#lineBuffer,
        );
        await this.#updatePrompt(args.denops);
        await this.#notifyPromptChanges(args.denops);
      }
      return ActionFlags.Persist;
    },
    redoInput: async (args: { denops: Denops }) => {
      const buf = this.#lineBufferHistory.next();
      if (buf) {
        this.#lineBuffer = buf;
        await this.#lineBufferDisplay.updateDisplay(
          args.denops,
          this.#lineBuffer,
        );
        await this.#updatePrompt(args.denops);
        await this.#notifyPromptChanges(args.denops);
      }
      return ActionFlags.Persist;
    },

    // Belows are "Insert mode" actions.
    moveToNormalMode: async (args: { denops: Denops }) => {
      const mode = ensure(
        await args.denops.call(
          "ddu#ui#ff_vim_popup#internal#CallKeymapperMethod",
          this.#uiStateId!,
          "get_mode",
        ),
        is.String,
      );
      if (mode === "i") {
        this.#lineBufferHistory.push(this.#lineBuffer);
      }
      await invokeVimFunction(
        args.denops,
        "ddu#ui#ff_vim_popup#internal#CallKeymapperMethod",
        this.#uiStateId,
        "set_mode",
        "n",
      );
      await this.#updatePrompt(args.denops);
      return ActionFlags.Persist;
    },
    addChar: async (args: { denops: Denops; actionParams: unknown }) => {
      const { count1 = 1 } = ensure(args.actionParams, isActionParamCount1);
      const ch =
        ensure(args.actionParams, is.ObjectOf({ char: is.String })).char;
      const str = ch.repeat(count1);
      this.#lineBuffer.text =
        this.#lineBuffer.text.slice(0, this.#lineBuffer.charColumn) + str +
        this.#lineBuffer.text.slice(this.#lineBuffer.charColumn);
      this.#lineBuffer.charColumn += str.length;
      await this.#updatePrompt(args.denops);
      await this.#notifyPromptChanges(args.denops);
      return ActionFlags.Persist;
    },
    deleteByRegex: async (args: { denops: Denops; actionParams: unknown }) => {
      const { count1 = 1 } = ensure(args.actionParams, isActionParamCount1);
      assert(args.actionParams, is.ObjectOf({ regex: is.String }));
      await this.#lineBuffer.deleteByRegex(
        args.denops,
        args.actionParams.regex,
        count1,
      );
      await this.#updatePrompt(args.denops);
      await this.#notifyPromptChanges(args.denops);
      return ActionFlags.Persist;
    },
    deleteChar: async (args: { denops: Denops; actionParams: unknown }) => {
      const { count1 = 1 } = ensure(args.actionParams, isActionParamCount1);
      await this.#lineBuffer.deleteByRegex(args.denops, ".\\%#", count1);
      await this.#updatePrompt(args.denops);
      await this.#notifyPromptChanges(args.denops);
      return ActionFlags.Persist;
    },
    deleteWord: async (args: { denops: Denops; actionParams: unknown }) => {
      const { count1 = 1 } = ensure(args.actionParams, isActionParamCount1);
      await this.#lineBuffer.deleteByRegex(
        args.denops,
        "\\s*\\w\\+\\%#",
        count1,
      );
      await this.#updatePrompt(args.denops);
      await this.#notifyPromptChanges(args.denops);
      return ActionFlags.Persist;
    },
    deleteToHead: async (args: { denops: Denops }) => {
      this.#lineBuffer.text = this.#lineBuffer.text.slice(
        this.#lineBuffer.charColumn,
      );
      this.#lineBuffer.charColumn = 0;
      await this.#updatePrompt(args.denops);
      await this.#notifyPromptChanges(args.denops);
      return ActionFlags.Persist;
    },
    moveForward: async (args: { denops: Denops }) => {
      if (this.#lineBuffer.charColumn < this.#lineBuffer.text.length) {
        this.#lineBuffer.charColumn += 1;
      }
      await this.#updatePrompt(args.denops);
      return ActionFlags.Persist;
    },
    moveBackward: async (args: { denops: Denops }) => {
      if (this.#lineBuffer.charColumn > 0) {
        this.#lineBuffer.charColumn -= 1;
      }
      await this.#updatePrompt(args.denops);
      return ActionFlags.Persist;
    },
    moveToHead: async (args: { denops: Denops }) => {
      this.#lineBuffer.charColumn = 0;
      await this.#updatePrompt(args.denops);
      return ActionFlags.Persist;
    },
    moveToTail: async (args: { denops: Denops }) => {
      this.#lineBuffer.charColumn = this.#lineBuffer.text.length;
      await this.#updatePrompt(args.denops);
      return ActionFlags.Persist;
    },
  };

  override params(): Params {
    return {
      bounds: async (denops: Denops) => {
        const scWidth = ensure(await vars.go.get(denops, "columns"), is.Number);
        const scHeight = ensure(
          await vars.go.get(denops, "lines"),
          is.Number,
        );
        const width = Math.max(
          Math.trunc(scWidth * 4 / 5),
          Math.min(50, scWidth),
        );
        const height = Math.max(
          Math.trunc(scHeight * 4 / 5),
          Math.min(20, scHeight),
        );
        const finder = {
          line: Math.trunc((scHeight - height) / 2),
          col: Math.trunc((scWidth - width) / 2),
          width: Math.trunc(width / 2),
          height: height,
        };
        const preview = {
          line: finder.line,
          col: finder.col + finder.width + 1,
          width: width - finder.width,
          height: height,
        };
        return {
          finder: finder,
          preview: preview,
        };
      },
      listerBorder: {
        mask: [1, 1, 1, 1],
        chars: [],
      },
      filterBorder: {
        mask: [1, 1, 1, 1],
        chars: [],
      },
      previewBorder: {
        mask: [1, 1, 1, 1],
        chars: [],
      },
      filterPosition: "top",
      highlights: {
        cursorline: "Cursorline",
        cursor: "Cursor",
        popup: "Normal",
        selected: "Statement",
      },
      reversed: false,
      hideCursor: false,
      prompt: ">> ",
      handleCtrlC: false,
    };
  }
}
