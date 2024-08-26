import { ActionFlags, type Denops } from "jsr:@shougo/ddu-vim@~5.0.0/types";
import { batch } from "jsr:@denops/std@~7.0.1/batch";
import * as fn from "jsr:@denops/std@~7.0.1/function";
import * as vimFn from "jsr:@denops/std@~7.0.1/function/vim";
import { assert, ensure, is } from "jsr:@core/unknownutil@~4.3.0";
import { pick } from "jsr:@std/collections@~1.0.0/pick";
import { Popup, type PopupCreateArgs, type UserCallback } from "./base.ts";
import {
  LineBuffer,
  LineBufferDisplay,
  LineBufferHistory,
} from "../linebuffer.ts";
import { isActionParamCount1, Params } from "../../ff_vim_popup.ts";
import { invokeVimFunction } from "../util.ts";

export class FilterPopup extends Popup {
  static readonly #cursorPropTypeName = "ddu-ui-ff_vim_popup-prop-type-cursor";

  #keyhandlerId?: string;
  #lineBuffer: LineBuffer = new LineBuffer();
  #lineBufferDisplay: LineBufferDisplay = new LineBufferDisplay();
  #lineBufferHistory: LineBufferHistory = new LineBufferHistory();
  #uiName?: string;

  onInit() {
    this.#lineBufferHistory.push(this.#lineBuffer); // Push the initial state to the history.
  }

  async onClose(denops: Denops) {
    const id = this.#keyhandlerId;

    this.#lineBuffer = new LineBuffer(); // Clear inputs.
    this.#lineBufferDisplay = new LineBufferDisplay();
    this.#lineBufferHistory = new LineBufferHistory();
    this.#keyhandlerId = undefined;
    this.#uiName = undefined;

    if (id) {
      await invokeVimFunction(
        denops,
        "ddu#ui#ff_vim_popup#keyhandler#DisposeHandler",
        id,
      );
    }
  }

  async openWindow(
    denops: Denops,
    layout: PopupCreateArgs,
    callback: UserCallback,
    uiParams: Params,
    uiName: string,
  ): Promise<void> {
    this.#keyhandlerId = ensure(
      await denops.call(
        "ddu#ui#ff_vim_popup#keyhandler#CreateNewHandler",
        pick(uiParams, ["hideCursor"]),
      ),
      is.String,
    );
    this.#uiName = uiName;

    const provider = ["ddu#ui#ff_vim_popup#keyhandler#SetupKeyHandler", [
      this.#keyhandlerId!,
    ]] as [string, unknown[]];

    this.#lineBufferDisplay.setMaxDisplayWidth(layout.maxwidth);
    await this.#lineBufferDisplay.setPromptText(
      denops,
      uiParams.prompt,
    );
    await super.open(denops, layout, [provider], callback);

    await fn.setbufvar(
      denops,
      this.getBufnr()!,
      "ddu_ui_name",
      uiName,
    );
    await vimFn.prop_type_add(denops, FilterPopup.#cursorPropTypeName, {
      highlight: uiParams.highlights.cursor,
      bufnr: this.getBufnr(),
    });
    await this.#updatePrompt(denops);
  }

  async #updatePrompt(denops: Denops) {
    const mode = ensure(
      await denops.call(
        "ddu#ui#ff_vim_popup#keyhandler#GetMode",
        this.#keyhandlerId,
      ),
      is.String,
    );
    await this.#lineBufferDisplay.updateDisplay(denops, this.#lineBuffer);
    if (mode === "n") {
      await batch(denops, async (denops) => {
        await this.setText(denops, this.#lineBufferDisplay.getDisplay().text);
        await vimFn.prop_clear(denops, 1, 1, {
          bufnr: this.getBufnr(),
        });
      });
    } else {
      const display = this.#lineBufferDisplay.getDisplay();
      const byteColumn = display.byteColumn + 1; // Make 1-indexed.
      const bufnr = this.getBufnr();
      await batch(denops, async (denops) => {
        await this.setText(denops, display.text);
        await vimFn.prop_clear(denops, 1, 1, { bufnr: bufnr });
        if (display.charColumn < display.text.length) {
          await vimFn.prop_add(denops, 1, byteColumn, {
            type: FilterPopup.#cursorPropTypeName,
            length: 1,
            bufnr: bufnr,
          });
        } else {
          await vimFn.prop_add(denops, 1, 0, {
            type: FilterPopup.#cursorPropTypeName,
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

  // Normal mode actions
  async actionMoveToInsertMode(args: { denops: Denops }): Promise<ActionFlags> {
    await invokeVimFunction(
      args.denops,
      "ddu#ui#ff_vim_popup#keyhandler#SetMode",
      this.#keyhandlerId,
      "i",
    );
    await this.#updatePrompt(args.denops);
    return ActionFlags.Persist;
  }

  async actionUndoInput(args: { denops: Denops }): Promise<ActionFlags> {
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
  }

  async actionRedoInput(args: { denops: Denops }): Promise<ActionFlags> {
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
  }

  // Insert mode actions
  async actionMoveToNormalMode(args: { denops: Denops }): Promise<ActionFlags> {
    const mode = ensure(
      await args.denops.call(
        "ddu#ui#ff_vim_popup#keyhandler#GetMode",
        this.#keyhandlerId,
      ),
      is.String,
    );
    if (mode === "i") {
      this.#lineBufferHistory.push(this.#lineBuffer);
    }
    await invokeVimFunction(
      args.denops,
      "ddu#ui#ff_vim_popup#keyhandler#SetMode",
      this.#keyhandlerId,
      "n",
    );
    await this.#updatePrompt(args.denops);
    return ActionFlags.Persist;
  }

  async actionAddChar(
    args: { denops: Denops; actionParams: unknown },
  ): Promise<ActionFlags> {
    const { count1 = 1 } = ensure(args.actionParams, isActionParamCount1);
    const ch = ensure(args.actionParams, is.ObjectOf({ char: is.String })).char;
    const str = ch.repeat(count1);
    this.#lineBuffer.text =
      this.#lineBuffer.text.slice(0, this.#lineBuffer.charColumn) + str +
      this.#lineBuffer.text.slice(this.#lineBuffer.charColumn);
    this.#lineBuffer.charColumn += str.length;
    await this.#updatePrompt(args.denops);
    await this.#notifyPromptChanges(args.denops);
    return ActionFlags.Persist;
  }

  async actionDeleteByRegex(
    args: { denops: Denops; actionParams: unknown },
  ): Promise<ActionFlags> {
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
  }

  async actionDeleteChar(
    args: { denops: Denops; actionParams: unknown },
  ): Promise<ActionFlags> {
    const { count1 = 1 } = ensure(args.actionParams, isActionParamCount1);
    await this.#lineBuffer.deleteByRegex(args.denops, String.raw`.\%#`, count1);
    await this.#updatePrompt(args.denops);
    await this.#notifyPromptChanges(args.denops);
    return ActionFlags.Persist;
  }

  async actionDeleteWord(
    args: { denops: Denops; actionParams: unknown },
  ): Promise<ActionFlags> {
    const { count1 = 1 } = ensure(args.actionParams, isActionParamCount1);
    await this.#lineBuffer.deleteByRegex(
      args.denops,
      String.raw`\w\+\s*\%#`,
      count1,
    );
    await this.#updatePrompt(args.denops);
    await this.#notifyPromptChanges(args.denops);
    return ActionFlags.Persist;
  }

  async actionDeleteToHead(args: { denops: Denops }): Promise<ActionFlags> {
    this.#lineBuffer.text = this.#lineBuffer.text.slice(
      this.#lineBuffer.charColumn,
    );
    this.#lineBuffer.charColumn = 0;
    await this.#updatePrompt(args.denops);
    await this.#notifyPromptChanges(args.denops);
    return ActionFlags.Persist;
  }

  async actionMoveForward(args: { denops: Denops }): Promise<ActionFlags> {
    if (this.#lineBuffer.charColumn < this.#lineBuffer.text.length) {
      this.#lineBuffer.charColumn += 1;
    }
    await this.#updatePrompt(args.denops);
    return ActionFlags.Persist;
  }

  async actionMoveBackward(args: { denops: Denops }): Promise<ActionFlags> {
    if (this.#lineBuffer.charColumn > 0) {
      this.#lineBuffer.charColumn -= 1;
    }
    await this.#updatePrompt(args.denops);
    return ActionFlags.Persist;
  }

  async actionMoveToHead(args: { denops: Denops }): Promise<ActionFlags> {
    this.#lineBuffer.charColumn = 0;
    await this.#updatePrompt(args.denops);
    return ActionFlags.Persist;
  }

  async actionMoveToTail(args: { denops: Denops }): Promise<ActionFlags> {
    this.#lineBuffer.charColumn = this.#lineBuffer.text.length;
    await this.#updatePrompt(args.denops);
    return ActionFlags.Persist;
  }
}
