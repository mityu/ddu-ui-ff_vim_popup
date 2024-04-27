import { Denops } from "https://deno.land/x/ddu_vim@v4.0.0/deps.ts";

export async function invokeVimFunction(
  denops: Denops,
  fn: string,
  ...args: unknown[]
) {
  await denops.call("ddu#ui#ff_vim_popup#internal#Invoke", fn, args);
}

export async function echomsgError(denops: Denops, msg: string) {
  await invokeVimFunction(
    denops,
    "ddu#ui#ff_vim_popup#internal#EchomsgError",
    msg,
  );
}

export function strBytesLength(s: string): number {
  return (new TextEncoder()).encode(s).length;
}

export function strBytesPart(s: string, begin: number, end?: number | undefined): string {
  const bytes = new TextEncoder().encode(s).slice(begin, end);
  return new TextDecoder().decode(bytes);
}
