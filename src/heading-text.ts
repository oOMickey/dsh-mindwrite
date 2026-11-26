// Shared lexical tests. Pasting an outline and importing a document decide structure separately.
export const sentenceEnd = /[。！？；：.!?;:…][”’」』）)"']*$/u;

export function sentenceTitle(text: string) {
  return /[，,。！？；：:;!?…]/u.test(text) || sentenceEnd.test(text);
}

export function shortHeading(text: string) {
  return text.length <= (/\p{Script=Han}/u.test(text) ? 24 : 48) && !sentenceTitle(text);
}

export const proseLead =
  /^(?:请(?:于|将|在|各)|截至|我们|已经|应当|本周已|本月已)|了(?:[一二三四五六七八九十两\d]|本次|本期|全部)|了$/u;
