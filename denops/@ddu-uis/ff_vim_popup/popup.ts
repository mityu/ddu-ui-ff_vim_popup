import { Denops, fn, is, ensure } from "https://deno.land/x/ddu_vim@v4.0.0/deps.ts";
import * as lambda from "https://deno.land/x/denops_std@v6.4.0/lambda/mod.ts";
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
    this.#winId = ensure(await denops.call("popup_create", "", opts), is.Number);
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
}
