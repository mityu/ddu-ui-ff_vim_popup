import {
  ActionFlags,
  as,
  assert,
  batch,
  type DduItem,
  type DduOptions,
  type Denops,
  ensure,
  equal,
  fn,
  is,
  type ItemHighlight,
  type PredicateType,
  vars,
} from "../deps.ts";
import { Popup, PopupCreateArgs } from "./base.ts";
import { invokeVimFunction, strBytesLength } from "../util.ts";
import { isActionParamCount1, Params } from "../../ff_vim_popup.ts";

const isSign = is.ObjectOf({
  name: is.String,
  group: is.String,
  id: as.Optional(is.Number),
});
type Sign = PredicateType<typeof isSign>;

export class ListerPopup extends Popup {
  #items: DduItem[] = [];
  #selectedItems: Set<number> = new Set();
  #maxDisplayItemLength: number = 0;
  #firstDisplayItem: number = 0;
  #cursorItem: number = 0;
  #scrolloff: number = 0;
  #signCursorline?: Sign;

  async onInit(denops: Denops) {
    this.#scrolloff = await vars.go.get(denops, "scrolloff");
  }

  async onClose(denops: Denops): Promise<void> {
    const signName = this.#signCursorline?.name;
    this.#selectedItems.clear();
    this.#signCursorline = undefined;
    if (signName) {
      await fn.sign_undefine(denops, signName);
    }
    return Promise.resolve();
  }

  async openWindow(
    denops: Denops,
    layout: PopupCreateArgs,
    uiParams: Params,
    sessionId: string,
  ): Promise<void> {
    this.#maxDisplayItemLength = layout.maxheight;
    this.#signCursorline = {
      name: `ddu-ui-ff_vim_popup-cursorline-${sessionId}`,
      group: "PopUpDduUiFFVimPopupCursorline",
    };

    await super.open(denops, layout, [], undefined);

    await batch(denops, async (denops) => {
      await fn.setwinvar(
        denops,
        this.getWinId()!,
        "&signcolumn",
        "yes",
      );

      await fn.sign_define(denops, this.#signCursorline!.name, {
        linehl: uiParams.highlights.cursorline,
        text: ">",
      });
    });
  }

  async redraw(denops: Denops, uiParams: Params): Promise<void> {
    // TODO: Set preview contents, etc.
    await this.#updateDisplayItems(denops, uiParams);
    await this.#updateCursorline(denops, uiParams.reversed);
  }

  refreshItems(items: DduItem[]) {
    this.#items = items;
    this.#selectedItems.clear();
    this.#firstDisplayItem = 0;
    this.#cursorItem = 0;
  }

  // This function is based on
  // https://github.com/Shougo/ddu-ui-ff/blob/60f642fe555ded2cc65fd5d903fd7d119ef86766/denops/%40ddu-uis/ff.ts#L753-L784
  // which distributed under the MIT License.
  collapseItem(item: DduItem): Promise<number> {
    // NOTE: treePath may be list.  So it must be compared by JSON.
    const startIndex = this.#items.findIndex(
      (item: DduItem) =>
        equal(item.treePath, item.treePath) &&
        item.__sourceIndex === item.__sourceIndex,
    );
    if (startIndex < 0) {
      return Promise.resolve(0);
    }

    const endIndex = this.#items.slice(startIndex + 1).findIndex(
      (item: DduItem) => item.__level <= item.__level,
    );

    const prevLength = this.#items.length;
    if (endIndex < 0) {
      this.#items = this.#items.slice(0, startIndex + 1);
    } else {
      this.#items = this.#items.slice(0, startIndex + 1).concat(
        this.#items.slice(startIndex + endIndex + 1),
      );
    }

    this.#items[startIndex] = item;

    this.#selectedItems.clear();

    return Promise.resolve(prevLength - this.#items.length);
  }

  // This function is based on
  // https://github.com/Shougo/ddu-ui-ff/blob/60f642fe555ded2cc65fd5d903fd7d119ef86766/denops/%40ddu-uis/ff.ts#L717-L751
  // which distributed under the MIT License.
  expandItem(args: {
    uiParams: Params;
    parent: DduItem;
    children: DduItem[];
    isGrouped: boolean;
  }): Promise<number> {
    // NOTE: treePath may be list.  So it must be compared by JSON.
    const index = this.#items.findIndex(
      (item: DduItem) =>
        equal(item.treePath, args.parent.treePath) &&
        item.__sourceIndex === args.parent.__sourceIndex,
    );

    const insertItems = args.children;

    const prevLength = this.#items.length;
    if (index >= 0) {
      if (args.isGrouped) {
        // Replace parent
        this.#items[index] = insertItems[0];
      } else {
        this.#items = this.#items.slice(0, index + 1).concat(insertItems)
          .concat(
            this.#items.slice(index + 1),
          );
        this.#items[index] = args.parent;
      }
    } else {
      this.#items = this.#items.concat(insertItems);
    }

    this.#selectedItems.clear();

    return Promise.resolve(prevLength - this.#items.length);
  }

  async searchItem(args: {
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
      await this.#updateDisplayItems(args.denops, args.uiParams);
      await this.#updateCursorline(args.denops, args.uiParams.reversed);
    }
  }

  getCurrentItem(): DduItem | undefined {
    if (this.#items.length === 0) {
      return undefined;
    }
    return this.#items[this.#cursorItem];
  }

  getItemsForAction(): DduItem[] {
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

  async #updateDisplayItems(
    denops: Denops,
    uiParams: Params,
  ) {
    const getTreePrefix = (item: DduItem) => {
      if (uiParams.displayTree) {
        const label = !item.isTree ? "  " : item.__expanded ? "- " : "+ ";
        return " ".repeat(item.__level) + label;
      } else {
        return "";
      }
    };
    const displayItems = (() => {
      const items = this.#items.slice(
        this.#firstDisplayItem,
        this.#firstDisplayItem + this.#maxDisplayItemLength,
      );
      if (uiParams.reversed) {
        return items.reverse();
      } else {
        return items;
      }
    })();
    const itemTexts = displayItems.map((v: DduItem): string => {
      return getTreePrefix(v) + (v.display ?? v.word);
    });
    const itemHighlights = displayItems.flatMap((v: DduItem, index: number) => {
      const linenr = index + 1;
      if (this.#selectedItems.has(this.#firstDisplayItem + index)) {
        return [{
          name: "ddu-ui-selected",
          hl_group: uiParams.highlights.selected,
          line: linenr,
          col: 1,
          width: strBytesLength(itemTexts[this.#firstDisplayItem + index]),
        }];
      } else if (v.highlights) {
        const prefixLen = strBytesLength(getTreePrefix(v));
        return v.highlights.map((v: ItemHighlight) => {
          return {
            name: v.name,
            hl_group: v.hl_group,
            line: linenr,
            col: v.col + prefixLen,
            width: v.width,
          };
        });
      } else {
        return [];
      }
    });
    await invokeVimFunction(
      denops,
      "ddu#ui#ff_vim_popup#popup#SetItems",
      this.getWinId(),
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
        buffer: this.getBufnr(),
        id: this.#signCursorline.id,
      });
      this.#signCursorline.id = undefined;
    }

    const signId = await fn.sign_place(
      denops,
      0,
      this.#signCursorline.group,
      this.#signCursorline.name,
      this.getBufnr()!,
      { lnum: getCursorline() },
    );
    if (signId != -1) {
      this.#signCursorline.id = signId;
    }
  }

  async actionSelectUpperItem(
    args: { denops: Denops; uiParams: Params; actionParams: unknown },
  ): Promise<ActionFlags> {
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
      await this.#updateDisplayItems(args.denops, args.uiParams);
      await this.#updateCursorline(args.denops, args.uiParams.reversed);
    } else if (this.#cursorItem !== cursorItem) {
      this.#cursorItem = cursorItem;
      await this.#updateCursorline(args.denops, args.uiParams.reversed);
    }

    return ActionFlags.Persist;
  }

  async actionSelectLowerItem(
    args: { denops: Denops; uiParams: Params; actionParams: unknown },
  ) {
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
      await this.#updateDisplayItems(args.denops, args.uiParams);
      await this.#updateCursorline(args.denops, args.uiParams.reversed);
    } else if (this.#cursorItem !== cursorItem) {
      this.#cursorItem = cursorItem;
      await this.#updateCursorline(args.denops, args.uiParams.reversed);
    }

    return ActionFlags.Persist;
  }

  async actionCollapseItem(args: { denops: Denops; options: DduOptions }) {
    if (this.#items.length === 0) {
      return ActionFlags.None;
    }

    const item = this.#items[this.#cursorItem];
    if (!item.isTree || item.__level < 0) {
      return ActionFlags.None;
    }

    await args.denops.dispatcher.redrawTree(
      args.options.name,
      "collapse",
      [{ item }],
    );

    return ActionFlags.None;
  }

  async actionExpandItem(args: {
    denops: Denops;
    options: DduOptions;
    actionParams: unknown;
  }): Promise<ActionFlags> {
    if (this.#items.length === 0) {
      return ActionFlags.None;
    }

    const isExpandItemParams = is.ObjectOf({
      mode: as.Optional(is.LiteralOf("toggle")),
      maxLevel: as.Optional(is.Number),
      isGrouped: as.Optional(is.Boolean),
    });

    const item = this.#items[this.#cursorItem];
    const params = ensure(args.actionParams, isExpandItemParams);

    if (item.__expanded) {
      if (params.mode === "toggle") {
        return await this.actionCollapseItem(args);
      }
      return ActionFlags.None;
    }

    await args.denops.dispatcher.redrawTree(
      args.options.name,
      "expand",
      [{
        item,
        maxLevel: params.maxLevel ?? 0,
        isGrouped: params.isGrouped ?? false,
      }],
    );
    return ActionFlags.None;
  }

  actionToggleSelectItem(): number {
    if (this.#items.length === 0) {
      return ActionFlags.None;
    }

    if (this.#selectedItems.has(this.#cursorItem)) {
      this.#selectedItems.delete(this.#cursorItem);
    } else {
      this.#selectedItems.add(this.#cursorItem);
    }
    return ActionFlags.Redraw;
  }

  actionToggleAllItems(): number {
    const s = new Set([...Array(this.#items.length).keys()]);
    this.#selectedItems = s.difference(this.#selectedItems);
    return ActionFlags.Redraw;
  }

  actionClearSelectAllItems(): number {
    this.#selectedItems.clear();
    return ActionFlags.Redraw;
  }
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
