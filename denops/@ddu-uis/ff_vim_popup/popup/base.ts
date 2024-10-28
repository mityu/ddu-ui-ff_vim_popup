import type { Denops } from "jsr:@denops/std@~7.1.0";
import { batch } from "jsr:@denops/std@~7.1.0/batch";
import * as lambda from "jsr:@denops/std@~7.1.0/lambda";
import * as fn from "jsr:@denops/std@~7.1.0/function";
import * as vimFn from "jsr:@denops/std@~7.1.0/function/vim";
import { assert, ensure, is } from "jsr:@core/unknownutil@~4.3.0";
import { echomsgError } from "../util.ts";

export type UserCallback = (denops: Denops, winId: number) => Promise<void>;

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
    exOptsProviders: [string, unknown[]][],
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

    const provider = [
      "ddu#ui#ff_vim_popup#popup#SetupPopupCallback",
      [
        denops.name,
        this.#callback.id,
      ],
    ];
    this.#winId = ensure(
      await denops.call(
        "ddu#ui#ff_vim_popup#popup#OpenPopup",
        opts,
        [...exOptsProviders, provider],
      ),
      is.Number,
    );
    this.#bufnr = await fn.winbufnr(denops, this.#winId);
  }

  async close(denops: Denops): Promise<void> {
    if (this.exists()) {
      await vimFn.popup_close(denops, this.#winId);
    }
  }

  async setText(denops: Denops, text: string | string[]): Promise<void> {
    assert(this.#winId, is.Number);
    await vimFn.popup_settext(denops, this.#winId, text);
  }

  async setBuffer(denops: Denops, bufnr: number): Promise<void> {
    await batch(denops, async (denops: Denops) => {
      assert(this.#winId, is.Number);
      await denops.call("popup_setbuf", this.#winId, bufnr);
      await vimFn.popup_setoptions(denops, this.#winId, {
        highlight: this.#highlight,
        wrap: false,
      });
      await fn.setwinvar(denops, this.#winId, "&foldmethod", "manual");
      await fn.setwinvar(denops, this.#winId, "&foldenable", false);
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
