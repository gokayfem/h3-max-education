const MAX_CLIPS_PER_TURN = 6;
const MAX_SUBJECT_CHARS = 160;
const MIN_LIVE_CHARS = 24;
const MIN_LIVE_WORDS = 6;
const SENTENCE_BOUNDARY = /[.!?](?=\s|$)/u;

function normalizeSubject(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim();
}

function wordCount(value: string): number {
  return value.split(/\s+/u).filter(Boolean).length;
}

function cappedEnd(value: string, proposedEnd: number): number {
  if (proposedEnd <= MAX_SUBJECT_CHARS) return proposedEnd;
  const capped = value.slice(0, MAX_SUBJECT_CHARS);
  const lastSpace = capped.lastIndexOf(" ");
  return lastSpace >= MIN_LIVE_CHARS ? lastSpace : MAX_SUBJECT_CHARS;
}

export class StreamingSubjectBuffer {
  #turnId: string | null = null;
  #text = "";
  #consumed = 0;
  #emitted = 0;

  pushDelta(turnId: string, delta: string): string[] {
    if (this.#turnId !== turnId) this.#beginTurn(turnId);
    this.#text += delta;
    return this.#drain(false);
  }

  finish(turnId: string, fullText: string, interrupted: boolean): string[] {
    if (this.#turnId !== turnId) this.#beginTurn(turnId);
    if (interrupted) {
      this.reset();
      return [];
    }
    if (fullText.length >= this.#text.length) this.#text = fullText;
    const subjects = this.#drain(true);
    this.reset();
    return subjects;
  }

  reset(): void {
    this.#turnId = null;
    this.#text = "";
    this.#consumed = 0;
    this.#emitted = 0;
  }

  #beginTurn(turnId: string): void {
    this.#turnId = turnId;
    this.#text = "";
    this.#consumed = 0;
    this.#emitted = 0;
  }

  #drain(final: boolean): string[] {
    const subjects: string[] = [];
    while (this.#emitted < MAX_CLIPS_PER_TURN) {
      const pending = this.#text.slice(this.#consumed);
      const leadingWhitespace = pending.match(/^\s*/u)?.[0].length ?? 0;
      const content = pending.slice(leadingWhitespace);
      if (!content) break;

      const boundary = SENTENCE_BOUNDARY.exec(content);
      let end = boundary ? boundary.index + 1 : -1;
      if (end < 0 && !final) {
        const lastWhitespace = content.search(/\s+$/u) >= 0
          ? content.length
          : content.lastIndexOf(" ") + 1;
        const candidate = normalizeSubject(content.slice(0, lastWhitespace));
        if (
          candidate.length < MIN_LIVE_CHARS
          || wordCount(candidate) < MIN_LIVE_WORDS
        ) {
          break;
        }
        end = lastWhitespace;
      }
      if (end < 0 && final) end = content.length;
      if (end < 0) break;

      end = cappedEnd(content, end);
      const subject = normalizeSubject(content.slice(0, end));
      this.#consumed += leadingWhitespace + end;
      if (!subject) continue;
      if (!final && !boundary && wordCount(subject) < MIN_LIVE_WORDS) break;
      subjects.push(subject);
      this.#emitted += 1;
    }
    return subjects;
  }
}
