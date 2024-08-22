import { type Denops, ensure, is, lambda } from "./deps.ts";
import { invokeVimFunction } from "./util.ts";

export type CommandOptions = {
  term_rows?: number;
  term_cols?: number;
  cwd?: string;
  out_cb: (msg: string) => Promise<void>;
  err_cb: (msg: string) => Promise<void>;
  close_cb: () => Promise<void>;
};

export class Executor {
  #cmd: string[];
  #opts: CommandOptions;
  #callbacks: lambda.Lambda[];
  #termBufnr?: number;

  constructor(cmd: string[], opts: CommandOptions) {
    this.#cmd = cmd;
    this.#opts = opts;
    this.#callbacks = [];
  }

  async spawn(denops: Denops): Promise<void> {
    const out_cb = lambda.add(denops, async (msg: unknown) => {
      await this.#opts.out_cb(ensure(msg, is.String));
    });
    this.#callbacks.push(out_cb);

    const err_cb = lambda.add(denops, async (msg: unknown) => {
      await this.#opts.err_cb(ensure(msg, is.String));
    });
    this.#callbacks.push(err_cb);

    const close_cb = lambda.add(denops, async () => await this.#close_cb());
    this.#callbacks.push(close_cb);

    const opts = {
      hidden: true,
      term_finish: "close",
      out_cb: out_cb.id,
      err_cb: err_cb.id,
      close_cb: close_cb.id,
    };
    this.#termBufnr = ensure(
      await denops.call(
        "ddu#ui#ff_vim_popup#internal#TermStart",
        this.#cmd,
        denops.name,
        {
          ...this.#opts,
          ...opts,
        },
      ),
      is.Number,
    );
  }

  async abort(denops: Denops): Promise<void> {
    if (this.#termBufnr) {
      await invokeVimFunction(
        denops,
        "ddu#ui#ff_vim_popup#internal#TermKill",
        this.#termBufnr,
      );
      this.#termBufnr = undefined;
    }
  }

  async #close_cb(): Promise<void> {
    for (const cb of this.#callbacks) {
      cb.dispose();
    }
    await this.#opts.close_cb();
  }
}
