import {
  ActionFlags,
  BaseParams,
  Context,
  type DduItem,
  type DduOptions,
  PreviewContext,
  Previewer,
  UiOptions,
} from "jsr:@shougo/ddu-vim@~6.2.0/types";
import { BaseUi, UiActions } from "jsr:@shougo/ddu-vim@~6.2.0/ui";
import type { Denops } from "jsr:@denops/std@~7.1.0";
import { batch } from "jsr:@denops/std@~7.1.0/batch";
import * as vars from "jsr:@denops/std@~7.1.0/variable";
import {
  as,
  ensure,
  is,
  type PredicateType,
} from "jsr:@core/unknownutil@~4.3.0";
import { type PopupCreateArgs } from "./ff_vim_popup/popup/base.ts";
import { FilterPopup } from "./ff_vim_popup/popup/filter.ts";
import { ListerPopup } from "./ff_vim_popup/popup/lister.ts";
import { PreviewPopup } from "./ff_vim_popup/popup/preview.ts";

export const isActionParamCount1 = is.ObjectOf({
  count1: as.Optional(is.Number),
});

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
export type LayoutParamsProvider = (denops: Denops) => Promise<LayoutParams>;

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
    previewline: string;
  };
  startFilter: boolean;
  displayTree: boolean;
  reversed: boolean;
  hideCursor: boolean;
  prompt: string;
  handleCtrlC: boolean;
};

async function calcLayout(
  denops: Denops,
  uiParams: Params,
): Promise<Layout> {
  const normalizeBorder = (l: number[]) => l.map((v) => v === 0 ? 0 : 1);

  const isFilterTop = uiParams.filterPosition === "top";
  const bounds = await (async (): Promise<LayoutParams> => {
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
  const previewArgs = {
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
  } satisfies PopupCreateArgs;

  const filterBorder = normalizeBorder(uiParams.filterBorder.mask);
  const filterArgs = {
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
  } satisfies PopupCreateArgs;

  const filterHeight = 1 + filterBorder[0] + filterBorder[2];
  const listerBorder = normalizeBorder(uiParams.listerBorder.mask);
  const listerArgs = {
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
  } satisfies PopupCreateArgs;

  return {
    lister: listerArgs,
    filter: filterArgs,
    preview: previewArgs,
  };
}

export class Ui extends BaseUi<Params> {
  #sessionId?: string;
  #listerPopup: ListerPopup = new ListerPopup();
  #filterPopup: FilterPopup = new FilterPopup();
  #previewPopup: PreviewPopup = new PreviewPopup();

  override async onInit(
    args: { denops: Denops; uiParams: Params },
  ): Promise<void> {
    await this.#listerPopup.onInit(args.denops);
    this.#filterPopup.onInit();
  }

  override async onBeforeAction(): Promise<void> {
  }

  override async onAfterAction(): Promise<void> {
  }

  override refreshItems(args: {
    items: DduItem[];
  }): Promise<void> {
    this.#listerPopup.refreshItems(args.items);
    return Promise.resolve();
  }

  override collapseItem(args: {
    item: DduItem;
  }) {
    return this.#listerPopup.collapseItem(args.item);
  }

  override expandItem(args: {
    uiParams: Params;
    parent: DduItem;
    children: DduItem[];
    isGrouped: boolean;
  }) {
    return this.#listerPopup.expandItem(args);
  }

  override async searchItem(args: {
    denops: Denops;
    item: DduItem;
    uiParams: Params;
  }) {
    await this.#listerPopup.searchItem(args);
  }

  override clearSelectedItems() {
    this.#listerPopup.actionClearSelectAllItems();
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

    await this.#listerPopup.redraw(args.denops, args.uiParams);
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
    const uiName = args.options.name ?? "default";

    this.#sessionId = crypto.randomUUID();

    await this.#previewPopup.openWindow(args.denops, layout.preview);
    await this.#filterPopup.openWindow(
      args.denops,
      layout.filter,
      async (denops: Denops, _: number) =>
        // This may should be "quit" action of ddu.vim
        await this.#onClose(denops),
      args.uiParams,
      uiName,
    );
    await this.#listerPopup.openWindow(
      args.denops,
      layout.lister,
      args.uiParams,
      this.#sessionId,
    );

    if (args.uiParams.startFilter) {
      await this.#filterPopup.actionMoveToInsertMode({ denops: args.denops });
    }
  }

  async #onClose(denops: Denops) {
    if (!this.#sessionId) {
      // Closing process is already done.
      return;
    }
    this.#sessionId = undefined;

    await batch(denops, async (denops) => {
      await this.#filterPopup.onClose(denops);
      await this.#listerPopup.onClose(denops);
      await this.#listerPopup.close(denops);
      await this.#filterPopup.close(denops);
      await this.#previewPopup.close(denops);
    });
  }

  override actions: UiActions<Params> = {
    quit: async (args: {
      denops: Denops;
      options: DduOptions;
    }): Promise<ActionFlags> => {
      await this.#onClose(args.denops);
      await args.denops.dispatcher.pop(args.options.name);
      return ActionFlags.None;
    },
    itemAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const params = args.actionParams as DoActionParams;
      const items = params.items ?? this.#listerPopup.getItemsForAction();

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
    previewItem: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
      getPreviewer?: (
        denops: Denops,
        item: DduItem,
        actionParams: BaseParams,
        previewContext: PreviewContext,
      ) => Promise<Previewer | undefined>;
    }): Promise<ActionFlags> => {
      const item = this.#listerPopup.getCurrentItem();
      if (!item) {
        return ActionFlags.None;
      }
      return await this.#previewPopup.doPreview(
        args.denops,
        args.uiParams,
        args.actionParams,
        item,
        args.getPreviewer,
      );
    },
    selectUpperItem: this.#listerPopup.actionSelectUpperItem.bind(
      this.#listerPopup,
    ),
    selectLowerItem: this.#listerPopup.actionSelectLowerItem.bind(
      this.#listerPopup,
    ),
    collapseItem: this.#listerPopup.actionCollapseItem.bind(this.#listerPopup),
    expandItem: this.#listerPopup.actionExpandItem.bind(this.#listerPopup),
    toggleSelectItem: this.#listerPopup.actionToggleSelectItem.bind(
      this.#listerPopup,
    ),
    toggleAllItems: this.#listerPopup.actionToggleAllItems.bind(
      this.#listerPopup,
    ),
    clearSelectAllItems: this.#listerPopup.actionClearSelectAllItems.bind(
      this.#listerPopup,
    ),
    chooseAction: this.#listerPopup.actionChooseAction.bind(this.#listerPopup),
    // hoverItem {mode: "toggle" | "open" | "close"}

    // Normal mode actions
    moveToInsertMode: this.#filterPopup.actionMoveToInsertMode.bind(
      this.#filterPopup,
    ),
    undoInput: this.#filterPopup.actionUndoInput.bind(this.#filterPopup),
    redoInput: this.#filterPopup.actionRedoInput.bind(this.#filterPopup),

    // Insert mode actions
    moveToNormalMode: this.#filterPopup.actionMoveToNormalMode.bind(
      this.#filterPopup,
    ),
    addChar: this.#filterPopup.actionAddChar.bind(this.#filterPopup),
    deleteByRegex: this.#filterPopup.actionDeleteByRegex.bind(
      this.#filterPopup,
    ),
    deleteChar: this.#filterPopup.actionDeleteChar.bind(this.#filterPopup),
    deleteWord: this.#filterPopup.actionDeleteWord.bind(this.#filterPopup),
    deleteToHead: this.#filterPopup.actionDeleteToHead.bind(this.#filterPopup),
    moveForward: this.#filterPopup.actionMoveForward.bind(this.#filterPopup),
    moveBackward: this.#filterPopup.actionMoveBackward.bind(this.#filterPopup),
    moveToHead: this.#filterPopup.actionMoveToHead.bind(this.#filterPopup),
    moveToTail: this.#filterPopup.actionMoveToTail.bind(this.#filterPopup),
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
          col: finder.col + finder.width,
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
        previewline: "Search",
      },
      startFilter: false,
      displayTree: false,
      reversed: false,
      hideCursor: false,
      prompt: ">> ",
      handleCtrlC: false,
    };
  }
}
