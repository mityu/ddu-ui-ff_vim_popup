import { type Denops } from "jsr:@shougo/ddu-vim@~5.0.0/types";

export async function invokeVimFunction(
  denops: Denops,
  fn: string,
  ...args: unknown[]
) {
  await denops.call("ddu#ui#ff_vim_popup#util#Invoke", fn, args);
}

export async function echomsgError(denops: Denops, msg: string) {
  await invokeVimFunction(
    denops,
    "ddu#ui#ff_vim_popup#util#EchomsgError",
    msg,
  );
}

export function strBytesLength(s: string): number {
  return (new TextEncoder()).encode(s).length;
}

export function strBytesPart(
  s: string,
  begin: number,
  end?: number | undefined,
): string {
  const bytes = new TextEncoder().encode(s).slice(begin, end);
  return new TextDecoder().decode(bytes);
}
