import { type Denops } from "jsr:@shougo/ddu-vim@~5.0.0/types";
import { ensure, is } from "jsr:@core/unknownutil@~4.3.0";
import * as fn from "jsr:@denops/std@~7.1.0/function";
import { strBytesLength, strBytesPart } from "./util.ts";

export class LineBuffer {
  text: string = "";
  charColumn: number = 0; // Cursor column in characters, 0-indexed.

  async deleteByRegex(denops: Denops, regexGiven: string, count1: number) {
    const regElems = regexGiven.split(/(?<=(?:^|[^\\])(?:\\\\)*)\\%#/);
    for (const _ of Array(count1)) {
      const regex = regElems.join(`\\%${this.getByteColumn() + 1}c`);
      const [s, e] = ensure(
        (await fn.matchstrpos(denops, this.text, regex)).slice(1),
        is.ArrayOf(is.Number),
      );
      if (s === -1) {
        continue;
      }
      const pre = strBytesPart(this.text, 0, s);
      this.text = pre + strBytesPart(this.text, e);
      this.charColumn = pre.length;
    }
  }

  getByteColumn(): number {
    return strBytesLength(this.text.slice(0, this.charColumn));
  }

  clone(): LineBuffer {
    return Object.assign(new LineBuffer(), this);
  }
}

type Display = {
  text: string;
  byteColumn: number;
  charColumn: number;
};

export class LineBufferDisplay {
  #buffer: Readonly<LineBuffer> = new LineBuffer();
  #maxWidth: number = 0;
  #firstDisplayColumn = 0;
  #text: string = "";
  #charColumn: number = 0;
  #byteColumn: number = 0;
  #prompt = {
    text: "",
    displayWidth: 0,
    byteLen: 0,
    charLen: 0,
  };

  setMaxDisplayWidth(maxWidth: number) {
    this.#maxWidth = maxWidth;
  }

  async setPromptText(denops: Denops, p: string) {
    this.#prompt.text = p;
    this.#prompt.displayWidth = await fn.strdisplaywidth(denops, p);
    this.#prompt.byteLen = strBytesLength(p);
    this.#prompt.charLen = p.length;
  }

  async updateDisplay(denops: Denops, buffer: Readonly<LineBuffer>) {
    const maxWidth = this.#maxWidth - this.#prompt.displayWidth;
    const delta = buffer.charColumn - this.#buffer.charColumn;
    if ((delta < 0) && (buffer.charColumn < this.#firstDisplayColumn)) {
      const text = buffer.text.slice(0, buffer.charColumn);
      const truncated = await this.#truncateHead(denops, text, maxWidth);
      this.#firstDisplayColumn = text.length - truncated.length;
      this.#text = buffer.text.slice(this.#firstDisplayColumn);
      this.#charColumn = buffer.charColumn - this.#firstDisplayColumn;
      this.#byteColumn = strBytesLength(this.#text.slice(0, this.#charColumn));
    } else {
      const text = buffer.text.slice(
        this.#firstDisplayColumn,
        buffer.charColumn,
      );
      if (await fn.strdisplaywidth(denops, text) < maxWidth) {
        this.#text = buffer.text.slice(this.#firstDisplayColumn);
      } else {
        this.#text = await this.#truncateHead(denops, text, maxWidth);
        this.#firstDisplayColumn += text.length - this.#text.length;
      }
      this.#charColumn = buffer.charColumn - this.#firstDisplayColumn;
      this.#byteColumn = strBytesLength(this.#text.slice(0, this.#charColumn));
    }
    Object.assign(this.#buffer, buffer);
  }

  getDisplay(): Display {
    return {
      text: this.#prompt.text + this.#text,
      byteColumn: this.#byteColumn + this.#prompt.byteLen,
      charColumn: this.#charColumn + this.#prompt.charLen,
    };
  }

  async #truncateHead(
    denops: Denops,
    text: string,
    width: number,
  ): Promise<string> {
    // TODO: binary search?
    while (await fn.strdisplaywidth(denops, text) >= width) {
      text = text.slice(1);
    }
    return text;
  }
}

export class LineBufferHistory {
  #history: LineBuffer[] = [];
  #curIdx: number = -1;

  push(v: LineBuffer) {
    this.#history.splice(this.#curIdx + 1);
    this.#history.push(v.clone());
    this.#curIdx = this.#history.length - 1;
  }

  prev(): LineBuffer | undefined {
    if (this.#history.length === 0 || this.#curIdx <= 0) {
      return undefined;
    }
    this.#curIdx--;
    return this.#history[this.#curIdx].clone();
  }

  next(): LineBuffer | undefined {
    if ((this.#curIdx + 1) >= this.#history.length) {
      // This condition includes the pattern of this.#history.length === 0.
      return undefined;
    }
    this.#curIdx++;
    return this.#history[this.#curIdx].clone();
  }
}
