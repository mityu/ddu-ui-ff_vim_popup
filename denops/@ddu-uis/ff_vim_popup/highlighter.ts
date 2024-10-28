import { type Denops } from "jsr:@denops/std@~7.3.0";
import { batch } from "jsr:@denops/std@~7.3.0/batch";
import * as fn from "jsr:@denops/std@~7.3.0/function";
import * as vimFn from "jsr:@denops/std@~7.3.0/function/vim";

type PropOpts = {
  propTypeName: string;
  highlight: string;
  line: number;
  col: number;
  len: number;
};

type MatchOpts = {
  highlight: string;
  pattern: string;
};

export class Highlighter {
  #winId: number;
  #bufnr: number;
  #matchIds: number[];

  constructor(winId: number, bufnr: number) {
    this.#winId = winId;
    this.#bufnr = bufnr;
    this.#matchIds = [];
  }

  async addProp(
    denops: Denops,
    opts: PropOpts,
  ): Promise<void> {
    const propType = await vimFn.prop_type_get(denops, opts.propTypeName, {
      bufnr: this.#bufnr,
    });
    if (Object.keys(propType).length === 0) {
      await vimFn.prop_type_add(denops, opts.propTypeName, {
        bufnr: this.#bufnr,
        highlight: opts.highlight,
        priority: 1,
        override: true,
      });
    }
    await vimFn.prop_add(denops, opts.line, opts.col, {
      length: opts.len,
      type: opts.propTypeName,
      bufnr: this.#bufnr,
      id: -1,
    });
  }

  async addMatch(
    denops: Denops,
    opts: MatchOpts,
  ): Promise<void> {
    const matchId = await fn.matchadd(
      denops,
      opts.highlight,
      opts.pattern,
      1,
      -1,
      { window: this.#winId },
    );
    this.#matchIds.push(matchId);
  }

  async clearAll(denops: Denops): Promise<void> {
    await batch(denops, async (denops: Denops) => {
      if (await fn.bufexists(denops, this.#bufnr)) {
        await vimFn.prop_clear(denops, 1, "$", { bufnr: this.#bufnr });
      }
      if (await fn.winbufnr(denops, this.#winId) > 0) {
        for (const matchId of this.#matchIds) {
          await fn.matchdelete(denops, matchId, this.#winId);
        }
      }
    });
  }

  getBufnr(): number {
    return this.#bufnr;
  }

  getWinId(): number {
    return this.#winId;
  }
}
