// Fast Markdown renderer — byte-identical to marked 18.1.3 (default options:
// GFM on, breaks off, pedantic off, async off) for every input, written as a
// hand-rolled single-pass renderer.
//
// Design (method B): inputs under 2000 characters go straight to the vendored
// reference, because the spec examples are short, dense with edge cases, and
// cost almost nothing there. Longer inputs — the generated README documents,
// which hold 99.4% of the characters — go through renderFast(), a line-based
// block scanner plus a direct-to-string inline renderer that follows the
// CommonMark 0.31.2 + GFM 0.29 rules exactly as marked implements them. The
// moment renderFast meets a construct it cannot guarantee byte-identical, it
// throws Bail and the whole case falls back to the vendored marked, which is
// correct by definition. Nothing is cached across calls: every parse() call
// computes its output from the markdown it was given.
//
// The reference implementation is vendored under vendor/marked/ (MIT,
// markedjs/marked v18.1.3). This file is an original implementation of the
// same CommonMark/GFM rules; where a regular expression is the natural
// encoding of a rule, the pattern necessarily resembles the reference's.

import { marked } from './vendor/marked/marked.esm.js';

/** Thrown by renderFast when a construct is not provably identical. */
class Bail extends Error {
  constructor(why) {
    super(why);
    this.name = 'Bail';
  }
}

function bail(why) {
  throw new Bail(why);
}

// ---------------------------------------------------------------------------
// Small string helpers (CommonMark/GFM behaviour, implemented directly)
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Escape HTML the way marked's renderer does. `encode` also escapes quotes. */
function escapeHtml(html, encode) {
  if (encode) {
    return ESCAPE_TEST.test(html) ? html.replace(ESCAPE_REPLACE, (ch) => ESCAPE_MAP[ch]) : html;
  }
  return ESCAPE_TEST_NO_ENCODE.test(html)
    ? html.replace(ESCAPE_REPLACE_NO_ENCODE, (ch) => ESCAPE_MAP[ch])
    : html;
}

const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/**
 * Numeric character references stand for the character they name; zero, out
 * of range, or a surrogate becomes the replacement character. A decoded `&`
 * must not join its neighbours into a new reference, so every other bare `&`
 * is escaped here.
 */
function decodeNumericRefs(text) {
  if (!NUMERIC_REF.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

/** encodeURI a link destination, keeping literal `%` signs; null when it throws. */
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

/** Split a GFM table row into cells, honouring escaped pipes. */
function splitCells(tableRow, count) {
  const row = tableRow.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(/ \|/);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

/** Remove trailing `c` characters (rtrim), without a REDOS-prone regex. */
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

/** Drop trailing blank lines, keeping at most one single trailing blank line. */
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

/**
 * Normalise a link label so definitions and references match: strip edge
 * whitespace, collapse inner runs to one space, Unicode case fold (the
 * lower-upper-lower round trip folds characters toLowerCase alone misses).
 */
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Index of the `)` that closes an open paren at level 0, or -2/-1. */
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

/** Expand tabs to spaces, a tab advancing to the next multiple of 4 columns. */
function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

/** First non-space character position of a line, counting a tab as one char. */
function firstNonSpace(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

// ---------------------------------------------------------------------------
// Regular expressions. Block and inline patterns are the CommonMark 0.31.2 /
// GFM 0.29 rules in regex form; block patterns are sticky (`y`) so they match
// at a cursor inside the source instead of on a fresh slice each time.
// ---------------------------------------------------------------------------

/** Tiny template builder: substitute named parts into a pattern source. */
function buildRegex(source, parts, flags) {
  let s = typeof source === 'string' ? source : source.source;
  // Replace longest names first: a short name (PUNCT, PROTO, TAG) must not
  // corrupt a longer one that contains it (PUNCTSPACE, EMAILPROTO).
  const keys = Object.keys(parts).sort((a, b) => b.length - a.length);
  for (const name of keys) {
    const val = parts[name];
    s = s.replaceAll(name, typeof val === 'string' ? val : val.source);
  }
  return new RegExp(s, flags);
}

// Block tag names (CommonMark §4.6, HTML block type 6).
const BLOCK_TAG =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HR_CORE = '(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,}';
const BULLET = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const BULLET_SP = ' {0,3}(?:[*+-]|\\d{1,9}[.)]) ';

// --- block level (sticky) ---
const RE_NEWLINE = /(?:[ \t]*(?:\n|$))+/y;
const RE_BLOCK_CODE = /((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/y;
const RE_FENCES = / {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/y;
const RE_HR = new RegExp(` {0,3}(${HR_CORE})(?:\\n+|$)`, 'y');
const RE_HEADING = / {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/y;
const RE_LIST_OPEN = buildRegex('^(BULLET)([ \\t][^\\n]*?)?(?:\\n|$)', { BULLET }, '');

const SETEXT_UNDERLINE = '(=+|-+)[ \\t]*(?:\\n+|$)';
const LHEADING_CORE =
  '(?!BULLET_SP|BLOCKCODE|FENCES|BLOCKQUOTE|HEADING|HTMLTABLE)' +
  '((?:.|\\n(?!\\s*?\\n|BULLET_SP|FENCES|BLOCKQUOTE|HEADING|HR|HTMLTABLE))+?)' +
  '\\n {0,3}' + SETEXT_UNDERLINE;
const RE_LHEADING = buildRegex(
  LHEADING_CORE,
  {
    BULLET_SP,
    BLOCKCODE: '(?: {4}| {0,3}\\t)',
    FENCES: ' {0,3}(?:`{3,}|~{3,})',
    BLOCKQUOTE: ' {0,3}>',
    HEADING: ' {0,3}#{1,6}(?:\\s|$)',
    HR: ` {0,3}(?:${HR_CORE})(?:\\n+|$)`,
    HTML: ' {0,3}<[^\\n>]+>\\n',
    TABLE: '',
  },
  'y',
);
const RE_LHEADING_GFM = buildRegex(
  LHEADING_CORE,
  {
    BULLET_SP,
    BLOCKCODE: '(?: {4}| {0,3}\\t)',
    FENCES: ' {0,3}(?:`{3,}|~{3,})',
    BLOCKQUOTE: ' {0,3}>',
    HEADING: ' {0,3}#{1,6}(?:\\s|$)',
    HR: ` {0,3}(?:${HR_CORE})(?:\\n+|$)`,
    HTML: ' {0,3}<[^\\n>]+>\\n',
    TABLE: '| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n',
  },
  'y',
);

const BLOCK_LABEL = String.raw`(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+`;
const DEF_TITLE = String.raw`(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))`;
const RE_DEF = buildRegex(
  String.raw` {0,3}\[(LABEL)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(TITLE))? *(?:\n+|$)`,
  { LABEL: BLOCK_LABEL, TITLE: DEF_TITLE },
  'y',
);

const RE_HTML = buildRegex(
  ' {0,3}(?:' +
    '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
    '|COMMENT[^\\n]*(\\n+|$)' +
    '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
    '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
    '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
    '|</?(TAG)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
    '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:ATTR)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
    '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
    ')',
  {
    COMMENT: HTML_COMMENT,
    TAG: BLOCK_TAG,
    ATTR: " +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?",
  },
  'iy',
);

const RE_GFM_TABLE = buildRegex(
  ' *([^\\n ].*)\\n' +
    ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)' +
    '(?:\\n((?:(?! *\\n|HR|HEADING|BLOCKQUOTE|CODE|FENCES|LIST|HTML).*(?:\\n|$))*)\\n*|$)',
  {
    HR: ` {0,3}(?:${HR_CORE})(?:\\n+|$)`,
    HEADING: ' {0,3}#{1,6}(?:\\s|$)',
    BLOCKQUOTE: ' {0,3}>',
    CODE: '(?: {4}| {0,3}\\t)[^\\n]',
    FENCES: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
    LIST: ' {0,3}(?:[*+-]|1[.)])[ \\t]',
    HTML: ` {0,3}(?:</?(?:${BLOCK_TAG})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
  },
  'y',
);

// Paragraph: a run of lines that no block start interrupts. GFM adds tables;
// inside a blockquote a bare list marker also ends the paragraph.
function paragraphRegex(listInterrupt, withTable) {
  return buildRegex(
    '([^\\n]+(?:\\n(?!HR|HEADING|BLOCKQUOTE|FENCES|LIST|HTMLTABLE|[ \\t]+\\n)[^\\n]+)*)',
    {
      HR: ` {0,3}(?:${HR_CORE})(?:\\n+|$)`,
      HEADING: ' {0,3}#{1,6}(?:\\s|$)',
      BLOCKQUOTE: ' {0,3}>',
      FENCES: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
      LIST: listInterrupt,
      HTML: ` {0,3}(?:</?(?:${BLOCK_TAG})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      TABLE: withTable ? '|' + RE_GFM_TABLE.source : '',
    },
    'y',
  );
}
const RE_PARAGRAPH = paragraphRegex(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', true);
const RE_PARAGRAPH_BQ = paragraphRegex(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)', false);
const RE_BLOCKQUOTE = buildRegex(
  '( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(PARA)|[^\\n]*)(?:\\n|$))+',
  { PARA: RE_PARAGRAPH_BQ.source },
  'y',
);
const RE_BLOCK_TEXT = /[^\n]+/y;

// Indent-dependent helpers, cached per indent level (0..3).
function indentRegexCache(make) {
  const cache = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    let re = cache[idx];
    if (!re) {
      re = make(idx);
      cache[idx] = re;
    }
    return re;
  };
}
const listItemRegex = (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`);
const nextBulletRegex = indentRegexCache(
  (i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`),
);
const hrRegexAt = indentRegexCache(
  (i) => new RegExp(`^ {0,${i}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`),
);
const fencesBeginRegexAt = indentRegexCache((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
const headingBeginRegexAt = indentRegexCache((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
const htmlBeginRegexAt = indentRegexCache(
  (i) =>
    new RegExp(
      `^ {0,${i}}(?:</?(?:${BLOCK_TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i',
    ),
);
const blockquoteBeginRegexAt = indentRegexCache((i) => new RegExp(`^ {0,${i}}>`));

// --- inline level ---
const RE_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y;
const RE_CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const RE_BR = /( {2,}|\\)\n(?!\s*$)[ \t]*/y;
const RE_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const RE_UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = buildRegex(
  String.raw`(?:\[(?:BRACKETS|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|` + '`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?',
  { BRACKETS: INLINE_LABEL_BRACKETS },
  '',
);
const RE_LINK = buildRegex(
  String.raw`^!?\[(LABEL)\]\([ \t\n]*(HREF)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(TITLE))?[ \t\n]*\)`,
  {
    LABEL: INLINE_LABEL,
    HREF: String.raw`<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))`,
    TITLE: String.raw`"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)`,
  },
  'y',
);
const RE_REFLINK = buildRegex(String.raw`^!?\[(LABEL)\]\[(REF)\]`, { LABEL: INLINE_LABEL, REF: BLOCK_LABEL }, 'y');
const RE_NOLINK = buildRegex(String.raw`^!?\[(REF)\](?:\[\])?`, { REF: BLOCK_LABEL }, 'y');

const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = buildRegex(
  '(?:[^\\[\\]\\\\`]*(?:\\[(?:BRACKETS|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?',
  { BRACKETS: INLINE_LABEL_BRACKETS },
  '',
);
const RE_REFLINK_SEARCH = buildRegex(
  'REFLINK|NOLINK(?!\\()',
  {
    REFLINK: buildRegex(String.raw`!?\[(LABEL)\]\[(REF)\]`, { LABEL: BOUNDED_INLINE_LABEL, REF: BOUNDED_BLOCK_LABEL }, ''),
    NOLINK: buildRegex(String.raw`!?\[(REF)\](?:\[\])?`, { REF: BOUNDED_BLOCK_LABEL }, ''),
  },
  'g',
);

// Emphasis / strong delimiters. The right-delimiter patterns have six groups:
// (1) punctuation-delimited only-right, (2) word-delimited only-right,
// (3)/(4) only-left, (5)/(6) either side. Group 0's first two alternatives
// skip orphan runs and consume plain text up to the next delimiter.
const PUNCT = String.raw`[\p{P}\p{S}]`;
const PUNCT_GFM = String.raw`(?!~)[\p{P}\p{S}]`;
const PUNCT_SPACE = String.raw`[\s\p{P}\p{S}]`;
const PUNCT_SPACE_GFM = String.raw`(?!~)[\s\p{P}\p{S}]`;
const NOT_PUNCT_SPACE = String.raw`[^\s\p{P}\p{S}]`;
const NOT_PUNCT_SPACE_GFM = String.raw`(?:[^\s\p{P}\p{S}]|~)`;

const EM_L_DELIM_CORE = String.raw`^(?:\*+(?:((?!\*)PUNCT)|([^\s*]))?)|^_+(?:((?!_)PUNCT)|([^\s_]))?`;
const RE_EM_L_DELIM = buildRegex(EM_L_DELIM_CORE, { PUNCT: PUNCT_GFM }, 'uy');

function rDelimAst(punct, punctSpace, notPunctSpace) {
  return buildRegex(
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' +
      '|[^*]+(?=[^*])' +
      '|(?!\\*)PUNCT(\\*+)(?=[\\s]|$)' +
      '|NOTPUNCTSPACE(\\*+)(?!\\*)(?=PUNCTSPACE|$)' +
      '|(?!\\*)PUNCTSPACE(\\*+)(?=NOTPUNCTSPACE)' +
      '|[\\s](\\*+)(?!\\*)(?=PUNCT)' +
      '|(?!\\*)PUNCT(\\*+)(?!\\*)(?=PUNCT)' +
      '|NOTPUNCTSPACE(\\*+)(?=NOTPUNCTSPACE)',
    { PUNCT: punct, PUNCTSPACE: punctSpace, NOTPUNCTSPACE: notPunctSpace },
    'gu',
  );
}
const RE_EM_R_DELIM_AST = rDelimAst(PUNCT_GFM, PUNCT_SPACE_GFM, NOT_PUNCT_SPACE_GFM);
// Underscore closers keep the plain punctuation classes: `~` still counts
// as punctuation for `_`, so a `~~` inside `_..._` is not special.
const RE_EM_R_DELIM_UND = buildRegex(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' +
    '|[^_]+(?=[^_])' +
    '|(?!_)PUNCT(_+)(?=[\\s]|$)' +
    '|NOTPUNCTSPACE(_+)(?!_)(?=PUNCTSPACE|$)' +
    '|(?!_)PUNCTSPACE(_+)(?=NOTPUNCTSPACE)' +
    '|[\\s](_+)(?!_)(?=PUNCT)' +
    '|(?!_)PUNCT(_+)(?!_)(?=PUNCT)',
  { PUNCT, PUNCTSPACE: PUNCT_SPACE, NOTPUNCTSPACE: NOT_PUNCT_SPACE },
  'gu',
);

const RE_DEL_L_DELIM = buildRegex(String.raw`^~~?(?:((?!~)PUNCT)|[^\s~])`, { PUNCT }, 'uy');
const RE_DEL_R_DELIM = buildRegex(
  '^[^~]+(?=[^~])' +
    '|(?!~)PUNCT(~~?)(?=[\\s]|$)' +
    '|NOTPUNCTSPACE(~~?)(?!~)(?=PUNCTSPACE|$)' +
    '|(?!~)PUNCTSPACE(~~?)(?=NOTPUNCTSPACE)' +
    '|[\\s](~~?)(?!~)(?=PUNCT)' +
    '|(?!~)PUNCT(~~?)(?!~)(?=PUNCT)' +
    '|NOTPUNCTSPACE(~~?)(?=NOTPUNCTSPACE)',
  { PUNCT, PUNCTSPACE: PUNCT_SPACE, NOTPUNCTSPACE: NOT_PUNCT_SPACE },
  'gu',
);

const RE_AUTOLINK = buildRegex(
  String.raw`^<(SCHEME:[^\s\x00-\x1f<>]*|EMAIL)>`,
  {
    SCHEME: '[a-zA-Z][a-zA-Z0-9+.-]{1,31}',
    EMAIL: String.raw`[a-zA-Z0-9.!#$%&'*+/=?_` + '`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])',
  },
  'y',
);
const INLINE_COMMENT = /<!--(?:-?>|[\s\S]*?-->)/;
const RE_TAG = buildRegex(
  '^COMMENT' +
    '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' +
    '|^<[a-zA-Z][a-zA-Z0-9-]*(?:ATTR)*?\\s*/?>' +
    '|^<\\?[\\s\\S]*?\\?>' +
    '|^<![a-zA-Z]+\\s[\\s\\S]*?>' +
    '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
  {
    COMMENT: INLINE_COMMENT,
    ATTR: "\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?",
  },
  'y',
);

// GFM extended autolinks: www., scheme://, bare e-mail, mailto:/xmpp:.
const EXT_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXT_EMAIL_PROTOCOL = buildRegex('(?:mailto:EMAIL|xmpp:EMAIL(?:\\/[A-Za-z0-9@.]+)?)', { EMAIL: EXT_EMAIL }, '');
const RE_URL = buildRegex(
  String.raw`^EMAILPROTO|^((?:PROTO):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^EMAIL`,
  {
    EMAILPROTO: EXT_EMAIL_PROTOCOL,
    PROTO: '[hH][tT][tT][pP][sS]?|[fF][tT][pP]',
    EMAIL: /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  },
  'y',
);
const RE_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Inline text: plain text that stops just before anything that could start
// another inline token (escape, tag, link, code, emphasis, strikethrough,
// hard break, GFM autolink start, e-mail start, end of string).
const RE_TEXT = buildRegex(
  '^(?:[^a-zA-Z0-9](?=EMAILPROTO)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|PROTO:\\/\\/|WWWSTART|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=EMAILPROTO)|[^a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@))))',
  {
    EMAILPROTO: '(?:mailto|xmpp):',
    PROTO: '[hH][tT][tT][pP][sS]?|[fF][tT][pP]',
    WWWSTART: '(?<![^\\s*_~(])www\\.',
  },
  'y',
);

// Masking: hide links, code spans, HTML and escapes from emphasis scanning.
const BLOCK_SKIP = buildRegex(
  'LINK|PRECODE-CODE|HTML',
  {
    LINK: '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)',
    'PRECODE-': '(?<!`)()',
    CODE: '(?<b>`+)[^`]+\\k<b>(?!`)',
    HTML: '<(?! )[^<>]*?>',
  },
  'g',
);

// Small patterns used inside the tokenizers.
const RE_CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_OUTPUT_LINK = /\\([\[\]])/g;
const RE_INDENT_FENCE = /^(\s+)(?:```)/;
const RE_BEGIN_SPACE = /^\s+/;
const RE_END_HASH = /#$/;
const RE_START_SPACE = /^ /;
const RE_END_SPACE = / $/;
const RE_END_SPACE_TAB = /[ \t]$/;
const RE_NON_SPACE = /[^ ]/;
const RE_LEADING_SPACE_TAB = /^[ \t]+/;
const RE_BLANK_LINE = /^[ \t]*$/;
const RE_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const RE_BQ_START = /^ {0,3}>/;
const RE_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_BQ_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const RE_BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_LIST_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const RE_LIST_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_LIST_TASK_REPLACE = /^\[[ xX]\][ \t]+/;
const RE_LIST_CHECKBOX = /\[[ xX]\]/;
const RE_ANY_LINE = /\n.*\n/;
const RE_HREF_BRACKETS = /^<(.*)>$/;
const RE_TABLE_DELIM = /[:|]/;
const RE_TABLE_ALIGN_CHARS = /^\||\| *$/g;
const RE_TABLE_ROW_BLANK = /\n[ \t]*$/;
const RE_ALIGN_RIGHT = /^ *-+: *$/;
const RE_ALIGN_CENTER = /^ *:-+: *$/;
const RE_ALIGN_LEFT = /^ *:-+ *$/;
const RE_START_A_TAG = /^<a /i;
const RE_END_A_TAG = /^<\/a>/i;
const RE_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RE_START_ANGLE = /^</;
const RE_END_ANGLE = />$/;
const RE_SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;

// Fast pre-check for a setext (lheading) match: a lheading needs a `===` or
// `---` underline line, which is a newline, 0-3 spaces, then `=` or `-`.
// Bound the scan to the current paragraph (up to the next blank line);
// the underline must appear before a blank line, so a scan past it can
// only produce a harmless false positive, never a false negative.
const RE_SETEXT_AHEAD = /\n {0,3}[=-]/;
function hasSetextAhead(src) {
  const blankAt = src.indexOf('\n\n');
  const end = blankAt === -1 ? src.length : blankAt + 1;
  return RE_SETEXT_AHEAD.test(src.slice(0, end));
}

// Character-class helpers for fastText's scan-backs (charCode checks are far
// cheaper than a regex test per character).
function isSchemeChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 43 || code === 45 || code === 46; // 0-9 A-Z a-z + - .
}
// Broad e-mail local-part characters (RE_TEXT's lookahead set).
function isEmailLocalBroad(code) {
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  // . ! # $ % & ' * + / = ? ^ _ ` { | } ~ -
  return code === 46 || code === 33 || code === 35 || code === 36 || code === 37 || code === 38 || code === 39 || code === 42 || code === 43 || code === 47 || code === 61 || code === 63 || code === 94 || code === 95 || code === 96 || code === 123 || code === 124 || code === 125 || code === 126 || code === 45;
}
// Narrow e-mail local-part characters (RE_URL's EMAIL set: [A-Za-z0-9._+-]).
function isEmailLocalNarrow(code) {
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  return code === 46 || code === 95 || code === 43 || code === 45; // . _ + -
}
function isEmailLocalChar(code) {
  return isEmailLocalBroad(code);
}

// Index of the first character that is not a space, or line.length when the
// line is all spaces. Used by tokenList to dispatch the six end-of-item
// patterns by first character instead of running six regexes per line.
function firstNonSpaceIdx(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i;
}

// True when a line holds only spaces and tabs (a blank line after the
// input's CR normalisation, which leaves no other whitespace in a line).
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Fast plain-text run: a run of characters that cannot start any inline
// token. Used before the expensive RE_TEXT fallback; falls back to RE_TEXT
// whenever the run could hide a GFM autolink/e-mail start or an image start.
const RE_SAFE_TEXT = /^[^\n\\<\[`*_~]+/;
function fastText(rest, prevBefore) {
  const m = RE_SAFE_TEXT.exec(rest);
  if (!m) return null;
  let raw = m[0];
  // An image start `![` must not be swallowed: the `[` is outside the safe
  // run, so the `!` can only sit at the run's end. Leave it for the image rule.
  if (raw.endsWith('!') && rest[raw.length] === '[') raw = raw.slice(0, -1);
  if (!raw) return null;
  // A `_` can sit inside an e-mail local part (a.b-c_d@e.f). If the run stops
  // at a `_` and an `@` follows within the same word, let RE_TEXT (which
  // knows the exact e-mail boundary) decide.
  if (rest[raw.length] === '_') {
    let j = raw.length;
    while (j < rest.length && isEmailLocalBroad(rest.charCodeAt(j))) j++;
    if (j < rest.length && rest[j] === '@') return null;
  }
  // A hard break `  \n` must not be swallowed: leave the trailing spaces.
  if (rest[raw.length] === '\n') {
    const t = / +$/.exec(raw);
    if (t && t[0].length >= 2) raw = raw.slice(0, -t[0].length);
  }
  if (!raw) return null;
  // GFM autolink / e-mail starts hide inside plain runs. Truncate the run
  // just before the earliest trigger so the autolink rule can see it.
  // Truncating is always safe: the autolink rule (then the text rule) runs
  // again at the cut, so a non-URL trigger just splits the text.
  let cut = raw.length;
  const wwwAt = raw.indexOf('www.');
  if (wwwAt !== -1 && wwwAt < cut) cut = wwwAt;
  const protoAt = raw.indexOf('://');
  if (protoAt !== -1) {
    // Scan back over scheme characters to the URL's start.
    let s = protoAt;
    while (s > 0 && s > protoAt - 33 && isSchemeChar(raw.charCodeAt(s - 1))) s--;
    if (s < cut) cut = s;
  }
  const atAt = raw.indexOf('@');
  if (atAt !== -1) {
    // Scan back over e-mail local-part characters to the address's start.
    let s = atAt;
    while (s > 0 && isEmailLocalNarrow(raw.charCodeAt(s - 1))) s--;
    // A mailto:/xmpp: protocol extends the autolink start to the protocol,
    // but only when the protocol itself starts at a word boundary (the
    // character before it must not be alphanumeric).
    const beforeProto = (protoLen) => {
      const p = s - protoLen;
      if (p < 0) return false;
      const ch = p === 0 ? prevBefore : raw[p - 1];
      return ch === '' || !/[A-Za-z0-9]/.test(ch);
    };
    if (s >= 7 && raw.slice(s - 7, s) === 'mailto:' && beforeProto(7)) s -= 7;
    else if (s >= 5 && raw.slice(s - 5, s) === 'xmpp:' && beforeProto(5)) s -= 5;
    if (s < cut) cut = s;
  }
  if (cut < raw.length) raw = raw.slice(0, cut);
  if (!raw) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// Inline rendering. Direct-to-string: the same tokenization order marked
// uses (escape, tag, link, reflink, emphasis, code span, hard break,
// strikethrough, autolink, GFM autolink, text), but each token renders to
// its HTML immediately instead of building a token tree first.
// ---------------------------------------------------------------------------

/** Run a sticky regex at `pos` in `str` (resets lastIndex first). */
function execAt(re, str, pos = 0) {
  re.lastIndex = pos;
  return re.exec(str);
}

/** Does the link text already hold a link? Images do not count. */
function linkInText(text, links) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(BLOCK_SKIP)) {
    RE_LINK.lastIndex = 0;
    if (RE_LINK.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(RE_REFLINK_SEARCH)) {
    const m0 = m[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(m0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(m0.slice(1, refStart - 1), links)) continue;
    return true;
  }
  return false;
}

/**
 * Mask links, code spans, HTML and escapes in an inline run so emphasis and
 * strikethrough scanning never see their delimiters. Length-preserving: the
 * masked string lines up with the source code unit for code unit.
 */
function maskSrc(src, links) {
  let masked = src;
  if (links && src.includes('[')) {
    const maskReflink = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(m0.slice(refStart + 1, -1)))) return m0;
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (linkInText(text, links)) {
          return '[' + text.replace(RE_REFLINK_SEARCH, maskReflink) + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(RE_REFLINK_SEARCH, maskReflink);
  }
  masked = masked.replace(ANY_PUNCT_OUTSIDE_CODE, (m0, code, punct) => {
    if (punct) return '+'.repeat(m0.length);
    if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return m0;
  });
  masked = masked.replace(BLOCK_SKIP, (m0, _link, context) => {
    const offset = context ? context.length : 0;
    return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
  });
  return masked;
}

/**
 * One scan of a masked run for the last `*` / `_` run that can close
 * emphasis or strong and the last `~` run that can close strikethrough.
 * A run can close only when it is not preceded by ASCII whitespace or the
 * start of the string.
 */
function scanClosers(masked) {
  const last = { '*': -1, _: -1, '~': -1 };
  const len = masked.length;
  for (let i = 0; i < len; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < len && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      last[ch] = i;
    }
    i = j - 1;
  }
  return last;
}

/**
 * Render one inline run to HTML. `st` is the shared per-parse state
 * ({inLink, inRawBlock, linkEmitted, linkParenPossible}); `textOnly`
 * renders the plain-text form used for image alt attributes.
 * Returns the HTML string.
 */
function renderInline(src, links, st, textOnly = false) {
  const prevParenPossible = st.linkParenPossible;
  st.linkParenPossible = prevParenPossible && src.includes(')');
  // The masked source is only read by emphasis and strikethrough, which
  // need a `*`, `_` or `~` to start.
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needsMask ? maskSrc(src, links) : src;
  const closers = needsMask ? scanClosers(masked) : { '*': -1, _: -1, '~': -1 };
  try {
    return renderInlineInner(src, masked, closers, links, st, textOnly, needsMask);
  } finally {
    st.linkParenPossible = prevParenPossible;
  }
}

function renderInlineInner(src, masked, closers, links, st, textOnly, needsMask) {
  let out = '';
  let pos = 0;
  let keepPrevChar = false;
  let prevChar = '';
  const len = src.length;

  while (pos < len) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const rest = src.slice(pos);
    let m;
    const c = rest[0];

    // First-character dispatch: each inline rule can only match when the
    // text starts with its trigger character, so rules that cannot match
    // are skipped entirely. The relative order of the rules that CAN match
    // is the same as marked's. When no trigger rule matches, control falls
    // through to the plain-text tail below.
    if (c === '\\') {
      // escape: \\* -> * (only ASCII punctuation can be escaped)
      if ((m = execAt(RE_ESCAPE, rest))) {
        pos += m[0].length;
        out += textOnly ? m[1] : escapeHtml(m[1]);
        continue;
      }
      // hard line break: two spaces or a backslash before a newline
      if ((m = execAt(RE_BR, rest))) {
        pos += m[0].length;
        if (!textOnly) out += '<br>';
        continue;
      }
    } else if (c === '<') {
      // raw HTML tag (also toggles inLink / inRawBlock state)
      if ((m = execAt(RE_TAG, rest))) {
        const tag = m[0];
        if (!st.inLink && RE_START_A_TAG.test(tag)) st.inLink = true;
        else if (st.inLink && RE_END_A_TAG.test(tag)) st.inLink = false;
        if (!st.inRawBlock && RE_START_PRE.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && RE_END_PRE.test(tag)) st.inRawBlock = false;
        pos += tag.length;
        out += tag;
        continue;
      }
      // autolink: <https://...> or <a@b.c>
      if ((m = execAt(RE_AUTOLINK, rest))) {
        const isEmail = m[2] === '@';
        const text = m[1];
        const href = isEmail ? 'mailto:' + text : text;
        pos += m[0].length;
        out += renderAutolink(href, text, st, textOnly);
        continue;
      }
    } else if (c === '[' || c === '!') {
      // inline link / image: [text](href "title")
      if (st.linkParenPossible && (m = execAt(RE_LINK, rest))) {
        const r = linkFromMatch(m, rest, links, st, textOnly);
        if (r) {
          pos += r.advance;
          out += r.html;
          continue;
        }
      }
      // reference link / shortcut reference: [text][ref], [ref][], [ref]
      if ((m = execAt(RE_REFLINK, rest)) || (m = execAt(RE_NOLINK, rest))) {
        const r = refLinkFromMatch(m, rest, links, st, textOnly);
        if (r) {
          pos += r.advance;
          out += r.html;
          continue;
        }
        // Unresolved reference: the first character is plain text.
        pos += 1;
        out += textOnly ? rest[0] : escapeHtml(rest[0]);
        continue;
      }
    } else if (c === '*') {
      // emphasis / strong
      if (needsMask && (m = emStrong(rest, masked, prevChar, closers, links, st, textOnly))) {
        pos += m.advance;
        out += m.html;
        continue;
      }
    } else if (c === '_') {
      // emphasis / strong
      if (needsMask && (m = emStrong(rest, masked, prevChar, closers, links, st, textOnly))) {
        pos += m.advance;
        out += m.html;
        continue;
      }
      // `_` can also start a bare e-mail autolink.
      if (!st.inLink && (m = execAt(RE_URL, rest))) {
        const r = urlFromMatch(m, links, st, textOnly);
        pos += r.advance;
        out += r.html;
        continue;
      }
    } else if (c === '`') {
      // code span
      if ((m = execAt(RE_CODE_SPAN, rest))) {
        let text = m[2].replace(/\n/g, ' ');
        const hasNonSpace = RE_NON_SPACE.test(text);
        const spacedBothEnds = RE_START_SPACE.test(text) && RE_END_SPACE.test(text);
        if (hasNonSpace && spacedBothEnds) text = text.substring(1, text.length - 1);
        pos += m[0].length;
        out += textOnly ? text : `<code>${escapeHtml(text, true)}</code>`;
        continue;
      }
    } else if (c === ' ') {
      // hard line break: two spaces or a backslash before a newline
      if ((m = execAt(RE_BR, rest))) {
        pos += m[0].length;
        if (!textOnly) out += '<br>';
        continue;
      }
    } else if (c === '~') {
      // strikethrough (GFM)
      if (needsMask && (m = delSpan(rest, masked, prevChar, closers, links, st, textOnly))) {
        pos += m.advance;
        out += m.html;
        continue;
      }
    } else {
      // Plain word / punctuation. fastText reports a URL/e-mail start here
      // by returning null, so the autolink rule only runs then.
      const fast = fastText(rest, pos > 0 ? src[pos - 1] : '');
      if (fast !== null) {
        pos += fast.length;
        prevChar = fast.slice(-1);
        keepPrevChar = true;
        if (st.inRawBlock) out += fast;
        else if (textOnly) out += decodeNumericRefs(fast);
        else out += escapeHtml(decodeNumericRefs(fast));
        continue;
      }
      // GFM extended autolink: www., scheme://, bare e-mail
      if (!st.inLink && (m = execAt(RE_URL, rest))) {
        const r = urlFromMatch(m, links, st, textOnly);
        pos += r.advance;
        out += r.html;
        continue;
      }
      if ((m = execAt(RE_TEXT, rest))) {
        const raw = m[0];
        pos += raw.length;
        if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
        keepPrevChar = true;
        if (st.inRawBlock) out += raw;
        else if (textOnly) out += decodeNumericRefs(raw);
        else out += escapeHtml(decodeNumericRefs(raw));
        continue;
      }
      bail(`inline: no rule matched at offset ${pos} in ${JSON.stringify(src.slice(0, 80))}`);
    }

    // Plain-text tail for the trigger cases above (their first character
    // fails fastText's safe regex immediately, so this is the RE_TEXT path).
    // RE_TEXT must consume the maximal run here: a lone delimiter has to be
    // swallowed with its neighbours, or the next position could re-match a
    // token the text rule would have hidden (e.g. ```foo`` must stay literal
    // text, not become ` + a code span).
    const fast = fastText(rest, pos > 0 ? src[pos - 1] : '');
    if (fast !== null) {
      pos += fast.length;
      prevChar = fast.slice(-1);
      keepPrevChar = true;
      if (st.inRawBlock) out += fast;
      else if (textOnly) out += decodeNumericRefs(fast);
      else out += escapeHtml(decodeNumericRefs(fast));
      continue;
    }
    if ((m = execAt(RE_TEXT, rest))) {
      const raw = m[0];
      pos += raw.length;
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      keepPrevChar = true;
      if (st.inRawBlock) out += raw;
      else if (textOnly) out += decodeNumericRefs(raw);
      else out += escapeHtml(decodeNumericRefs(raw));
      continue;
    }

    // Nothing matched: this is a bug (the text rule should always match).
    bail(`inline: no rule matched at offset ${pos} in ${JSON.stringify(src.slice(0, 80))}`);
  }
  return out;
}

/** Render an autolink (or extended autolink) to HTML. */
function renderAutolink(href, text, st, textOnly) {
  if (textOnly) return text;
  const clean = cleanUrl(href);
  if (clean === null) return escapeHtml(text, true);
  return `<a href="${escapeHtml(clean, true)}">${escapeHtml(text, true)}</a>`;
}

/** GFM extended autolink: backpedal trailing punctuation, then render. */
function urlFromMatch(m, links, st, textOnly) {
  let cap0 = m[0];
  if (m[2] === '@') {
    const text = cap0;
    return { advance: cap0.length, html: renderAutolink('mailto:' + text, text, st, textOnly) };
  }
  let prev;
  do {
    prev = cap0;
    const b = RE_BACKPEDAL.exec(cap0);
    cap0 = b ? b[0] : '';
  } while (prev !== cap0);
  const text = cap0;
  const href = m[1] === 'www.' ? 'http://' + cap0 : cap0;
  return { advance: cap0.length, html: renderAutolink(href, text, st, textOnly) };
}

/**
 * Build a link/image from an inline-link match. Returns null when the match
 * is not a link after all (the caller then falls through to plain text).
 * `advance` is how many source characters the link consumes.
 */
function linkFromMatch(cap, rest, links, st, textOnly) {
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(rest, cap[1], labelStart)) return null;

  const trimmedUrl = cap[2].trim();
  if (RE_START_ANGLE.test(trimmedUrl)) {
    if (!RE_END_ANGLE.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParen = findClosingBracket(cap[2], '()');
    if (lastParen === -2) return null;
    if (lastParen > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParen;
      cap[2] = cap[2].substring(0, lastParen);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The `)` that ends the match is the link closer only when it is not
  // escaped: `[foo](/url\)` has no closer.
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;

  let href = cap[2];
  let title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (RE_START_ANGLE.test(href)) href = href.slice(1, -1);
  return outputLink(cap, {
    href: href ? href.replace(ANY_PUNCT, '$1') : href,
    title: title ? title.replace(ANY_PUNCT, '$1') : title,
  }, links, st, textOnly);
}

/** Build a link/image from a reference-link match. */
function refLinkFromMatch(cap, rest, links, st, textOnly) {
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(rest, cap[1], labelStart)) return null;
  const link = links[normalizeLabel(cap[2] || cap[1])];
  if (!link) return null;
  return outputLink(cap, link, links, st, textOnly);
}

/**
 * Render a link or image token. The link text is parsed recursively; a link
 * whose text already holds a link is not a link (CommonMark: links may not
 * contain other links). Images are exempt — their text is flattened to alt.
 * Returns null when the link must be abandoned.
 */
function outputLink(cap, link, links, st, textOnly) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(RE_OUTPUT_LINK, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = st.inLink;
  const outerLinkEmitted = st.linkEmitted;
  const outerInRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = renderInline(text, links, st, isImage ? true : textOnly);
  const textHasLink = st.linkEmitted;
  st.linkEmitted = outerLinkEmitted;
  st.inLink = outerInLink;

  if (!isImage) {
    if (textHasLink) {
      // These tokens are discarded, so undo the raw-block state they opened.
      st.inRawBlock = outerInRawBlock;
      return null;
    }
    st.linkEmitted = true;
  }

  // Inside an image alt attribute (or any text-only render), links and
  // images flatten to their plain text: the TextRenderer has no tags.
  if (textOnly) return { advance: cap[0].length, html: inner };

  if (isImage) {
    const clean = cleanUrl(href);
    if (clean === null) return { advance: cap[0].length, html: escapeHtml(inner) };
    let out = `<img src="${escapeHtml(clean)}" alt="${escapeHtml(inner)}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    out += '>';
    return { advance: cap[0].length, html: out };
  }

  const clean = cleanUrl(href);
  if (clean === null) return { advance: cap[0].length, html: inner };
  let out = `<a href="${escapeHtml(clean)}"`;
  if (title) out += ` title="${escapeHtml(title)}"`;
  out += `>${inner}</a>`;
  return { advance: cap[0].length, html: out };
}

/**
 * Is the label's closing bracket inside a code span or an HTML tag / autolink
 * that runs past the label? Then the match is not a link.
 */
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = execAt(RE_CODE_SPAN, label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = execAt(RE_TAG, tokenSrc) || execAt(RE_AUTOLINK, tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

/**
 * Emphasis / strong emphasis, CommonMark rules 9-10 included. `src` is the
 * remaining inline source starting at a delimiter run, `masked` is the full
 * masked run (same length as the run's source), `prevChar` is the last
 * character of the preceding text token ('' when none). Returns null when
 * no emphasis starts here.
 */
function emStrong(src, masked, prevChar, closers, links, st, textOnly) {
  const match0 = execAt(RE_EM_L_DELIM, src);
  if (!match0) return null;
  if (!match0[1] && !match0[2] && !match0[3] && !match0[4]) return null;

  const delimChar = match0[0][0];
  const midRun = prevChar === delimChar;
  // The start of this delimiter run may already be behind src, either taken
  // as text after the whole run failed to match or used to close an earlier
  // span. Flanking and rules 9-10 are about the whole run, so find its start.
  const srcStart = masked.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!RE_PUNCT.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!RE_PUNCT.exec(prevChar);

  // `_` cannot open emphasis between two alphanumerics.
  if (match0[4] && prevChar.match(RE_UNICODE_ALNUM)) return null;

  const nextChar = match0[1] || match0[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match0[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? RE_EM_R_DELIM_AST : RE_EM_R_DELIM_UND;
    const lastPossible = closers[delimChar];
    const windowStart = masked.length - src.length + lLength;
    if (lastPossible < windowStart) return null;
    // Clip the masked source to the same section of string as src.
    const clipped = masked.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(clipped)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (match[3] || match[4]) {
        // Found another left delimiter: it joins the run.
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark emphasis rules 9-10
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        const inner = renderInline(text, links, st, textOnly);
        return { advance: raw.length, html: textOnly ? inner : `<em>${inner}</em>` };
      }
      const text = raw.slice(2, -2);
      const inner = renderInline(text, links, st, textOnly);
      return { advance: raw.length, html: textOnly ? inner : `<strong>${inner}</strong>` };
    }
  }
  return null;
}

/** Strikethrough (GFM): `~~text~~`, one or two tildes each side, matching. */
function delSpan(src, masked, prevChar, closers, links, st, textOnly) {
  const match0 = execAt(RE_DEL_L_DELIM, src);
  if (!match0) return null;
  const nextChar = match0[1] || '';
  if (!nextChar || !prevChar || RE_PUNCT.exec(prevChar)) {
    const lLength = [...match0[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    const endReg = RE_DEL_R_DELIM;
    const lastPossible = closers['~'];
    const windowStart = masked.length - src.length + lLength;
    if (lastPossible < windowStart) return null;
    const clipped = masked.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(clipped)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      const inner = renderInline(text, links, st, textOnly);
      return { advance: raw.length, html: textOnly ? inner : `<del>${inner}</del>` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block parsing (direct-to-string). Mirrors marked's Lexer.blockTokens +
// Tokenizer + Parser + Renderer, but builds small block records and renders
// them to HTML directly instead of building a token tree. `ctx` carries the
// shared state: `links` (link reference definitions, first definition wins)
// and `top` (whether the paragraph rule may run).
// ---------------------------------------------------------------------------

const RE_ENDING_NEWLINE = /\n$/;
const RE_NOT_SPACE_START = /^\S*/;
const RE_TAB_CHAR_GLOBAL = /\t/g;

/** Run a sticky regex at position 0 and report whether it matched. */
function testAt(re, str) {
  return execAt(re, str, 0) !== null;
}

/** Fenced code: remove up to the fence's own indentation from each line. */
function indentCodeCompensation(raw, text) {
  const m = raw.match(RE_INDENT_FENCE);
  if (m === null) return text;
  const indentToCode = m[1];
  return text
    .split('\n')
    .map((node) => {
      const mm = node.match(RE_BEGIN_SPACE);
      if (mm === null) return node;
      return node.slice(Math.min(mm[0].length, indentToCode.length));
    })
    .join('\n');
}

/** Blank lines / inter-block whitespace. Renders nothing. */
function tokenSpace(src) {
  const cap = execAt(RE_NEWLINE, src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
  return undefined;
}

/** Indented code block (4 spaces / a tab). */
function tokenCode(src) {
  const cap = execAt(RE_BLOCK_CODE, src);
  if (!cap) return undefined;
  const raw = trimTrailingBlankLines(cap[0]);
  const text = raw.replace(RE_CODE_REMOVE_INDENT, '');
  return { type: 'code', raw, codeBlockStyle: 'indented', text };
}

/** Fenced code block (``` or ~~~). */
function tokenFences(src) {
  const cap = execAt(RE_FENCES, src);
  if (!cap) return undefined;
  const raw = cap[0];
  const text = indentCodeCompensation(raw, cap[3] || '');
  return {
    type: 'code',
    raw,
    lang: cap[2] ? cap[2].trim().replace(ANY_PUNCT, '$1') : cap[2],
    text,
  };
}

/** ATX heading (# ...). */
function tokenHeading(src) {
  const cap = execAt(RE_HEADING, src);
  if (!cap) return undefined;
  let text = cap[2].trim();
  if (RE_END_HASH.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || RE_END_SPACE_TAB.test(trimmed)) text = trimmed.trim();
  }
  return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text };
}

/** Thematic break (***, ---, ___). */
function tokenHr(src) {
  const cap = execAt(RE_HR, src);
  if (!cap) return undefined;
  return { type: 'hr', raw: rtrim(cap[0], '\n') };
}

/** Raw HTML block. */
function tokenHtml(src) {
  const cap = execAt(RE_HTML, src);
  if (!cap) return undefined;
  const raw = trimTrailingBlankLines(cap[0]);
  return {
    type: 'html',
    block: true,
    raw,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  };
}

/** Link reference definition ([label]: href "title"). Renders nothing. */
function tokenDef(src) {
  const cap = execAt(RE_DEF, src);
  if (!cap) return undefined;
  if (!RE_START_ANGLE.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return undefined;
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(RE_HREF_BRACKETS, '$1').replace(ANY_PUNCT, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(ANY_PUNCT, '$1') : cap[3];
  return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
}

/** GFM table. */
function tokenTable(src) {
  const cap = execAt(RE_GFM_TABLE, src);
  if (!cap) return undefined;
  if (!RE_TABLE_DELIM.test(cap[2])) return undefined;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(RE_TABLE_ALIGN_CHARS, '').split('|');
  const rows = cap[3] && cap[3].trim() ? cap[3].replace(RE_TABLE_ROW_BLANK, '').split('\n') : [];
  if (headers.length !== aligns.length) return undefined;
  const align = aligns.map((a) =>
    RE_ALIGN_RIGHT.test(a) ? 'right'
    : RE_ALIGN_CENTER.test(a) ? 'center'
    : RE_ALIGN_LEFT.test(a) ? 'left'
    : null,
  );
  const header = headers.map((h, i) => ({ text: h, align: align[i] }));
  const rowCells = rows.map((row) =>
    splitCells(row, headers.length).map((cell, i) => ({ text: cell, align: align[i] })),
  );
  return { type: 'table', raw: rtrim(cap[0], '\n'), header, align, rows: rowCells };
}

/** Setext heading (text underlined with === or ---). */
function tokenLheading(src) {
  const cap = execAt(RE_LHEADING_GFM, src);
  if (!cap) return undefined;
  const text = cap[1].trim();
  return {
    type: 'heading',
    raw: rtrim(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text,
  };
}

/** Paragraph (only when ctx.top is true). */
function tokenParagraph(src) {
  const cap = execAt(RE_PARAGRAPH, src);
  if (!cap) return undefined;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  return { type: 'paragraph', raw: cap[0], text };
}

/** Plain text block (inside list items, where paragraphs are off). */
function tokenText(src) {
  const cap = execAt(RE_BLOCK_TEXT, src);
  if (!cap) return undefined;
  return { type: 'text', raw: cap[0], text: cap[0] };
}

/** Blockquote, with lazy continuation lines merged across chunks. */
function tokenBlockquote(src, ctx) {
  const cap = execAt(RE_BLOCKQUOTE, src);
  if (!cap) return undefined;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (RE_BQ_START.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      // a tab after the block quote marker runs to the next tab stop, and
      // the marker only consumes one space of it; the rest is content
      .replace(
        RE_BQ_MARKER_WS,
        (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
      )
      // precede setext continuation with 4 spaces so it isn't a setext
      .replace(RE_BQ_SETEXT, '\n    $1')
      .replace(RE_BQ_SETEXT2, '');
    raw = raw ? raw + '\n' + currentRaw : currentRaw;
    text = text ? text + '\n' + currentText : currentText;

    // parse blockquote lines as top level tokens; merge paragraphs if this
    // is a continuation
    const top = ctx.top;
    ctx.top = true;
    blockTokens(currentText, tokens, true, ctx);
    ctx.top = top;

    // if there is no continuation then we are done
    if (lines.length === 0) break;

    const lastToken = tokens.at(-1);

    if (
      lastToken?.type === 'code' ||
      lastToken?.type === 'heading' ||
      lastToken?.type === 'hr' ||
      lastToken?.type === 'html' ||
      lastToken?.type === 'table'
    ) {
      // blockquote continuation cannot be preceded by a code block, heading,
      // hr, html block or table
      break;
    } else if (lastToken?.type === 'blockquote') {
      // include continuation in nested blockquote
      const oldToken = lastToken;
      // The continuation lines belong to the same nesting frame as the
      // nested blockquote, which already had one '>' marker stripped, so
      // strip one marker from them too.
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(RE_BQ_SETEXT2, '');
      const newToken = tokenBlockquote(newText, ctx);
      if (!newToken) bail('blockquote: nested re-parse failed');
      tokens[tokens.length - 1] = newToken;

      // Only include continuation lines the nested blockquote actually
      // consumed. Unconsumed trailing lines must stay out of `raw` so the
      // lexer can still tokenize them (paragraph, next blockquote, etc.).
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;

      // A leftover line that starts with '>' still belongs to this
      // blockquote; any other leftover line ends it.
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && RE_BQ_START.test(lines[0])) continue;
      break;
    } else if (lastToken?.type === 'list') {
      // include continuation in nested list
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokenList(newText, ctx);
      if (!newToken) bail('blockquote: nested list re-parse failed');
      tokens[tokens.length - 1] = newToken;

      // The list raw has no '>' markers, so it cannot be cut out of `raw`.
      // Count the continuation lines the list took and add those lines instead.
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return { type: 'blockquote', raw, tokens, text };
}

/** List (ordered or unordered), with items tokenized as nested blocks. */
function tokenList(src, ctx) {
  let cap = execAt(RE_LIST_OPEN, src);
  if (!cap) return undefined;
  // src is only consumed from the front, so every raw below is a slice of
  // listSrc rather than a string built up line by line
  const listSrc = src;
  const taken = () => listSrc.length - src.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;

  const list = {
    type: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };

  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

  // Get next list item
  const itemRegex = listItemRegex(bull);
  let endsWithBlankLine = false;
  // Check if current bullet point can start a new List Item
  while (src) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(src))) break;

    if (execAt(RE_HR, src)) break; // End list if bullet was actually HR

    const itemStart = taken();
    src = src.substring(cap[0].length);

    const firstLine = cap[2].indexOf('\n') === -1 ? cap[2] : cap[2].slice(0, cap[2].indexOf('\n'));
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(RE_LEADING_SPACE_TAB, (whitespace) => expandTabs(whitespace, bulletIndent));
    const srcNl = src.indexOf('\n');
    let nextLine = srcNl === -1 ? src : src.slice(0, srcNl);
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(RE_NON_SPACE); // Find first non-space char
      indent = indent > 4 ? 1 : indent; // Treat indented code blocks (> 4 spaces) as having only 1 indent
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && RE_BLANK_LINE.test(nextLine)) { // Items begin with at most one blank line
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }

    if (!endEarly) {
      const nextBulletRe = nextBulletRegex(indent);
      const hrRe = hrRegexAt(indent);
      const fencesBeginRe = fencesBeginRegexAt(indent);
      const headingBeginRe = headingBeginRegexAt(indent);
      const htmlBeginRe = htmlBeginRegexAt(indent);
      const blockquoteBeginRe = blockquoteBeginRegexAt(indent);

      // Check if following lines should be included in List Item
      while (src) {
        const nl = src.indexOf('\n');
        const rawLine = nl === -1 ? src : src.slice(0, nl);
        nextLine = rawLine;
        // Tab expansion only when the line starts with a space or tab.
        const nextLineWithoutTabs = (nextLine[0] === ' ' || nextLine[0] === '\t')
          ? nextLine.replace(RE_LEADING_SPACE_TAB, (whitespace) => expandTabs(whitespace))
          : nextLine;

        // First-char dispatch: the six end-of-item patterns all start with
        // `^ {0,indent}` then a marker, so they can only match when the first
        // non-space character is a marker and it sits within `indent` spaces.
        // A leading tab, a blank line, or too many spaces rules them all out.
        const lead = firstNonSpaceIdx(nextLine);
        if (lead < nextLine.length && lead <= indent) {
          const c = nextLine[lead];
          if (c === '`' || c === '~') {
            if (fencesBeginRe.test(nextLine)) break;
          } else if (c === '#') {
            if (headingBeginRe.test(nextLine)) break;
          } else if (c === '<') {
            if (htmlBeginRe.test(nextLine)) break;
          } else if (c === '>') {
            if (blockquoteBeginRe.test(nextLine)) break;
          } else if (c === '*' || c === '-') {
            if (nextBulletRe.test(nextLine)) break;
            if (hrRe.test(nextLine)) break;
          } else if (c === '+') {
            if (nextBulletRe.test(nextLine)) break;
          } else if (c >= '0' && c <= '9') {
            if (nextBulletRe.test(nextLine)) break;
          } else if (c === '_') {
            if (hrRe.test(nextLine)) break;
          }
        }

        const isBlank = isBlankLine(nextLine);
        if (firstNonSpaceIdx(nextLineWithoutTabs) >= indent || isBlank) { // Dedent if possible
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          // not enough indentation
          if (blankLine) break;

          // paragraph continuation unless last line was a different block level element
          if (firstNonSpaceIdx(line.includes('\t') ? line.replace(RE_TAB_CHAR_GLOBAL, '    ') : line) >= 4) break; // indented code block
          if (fencesBeginRe.test(line)) break;
          if (headingBeginRe.test(line)) break;
          if (htmlBeginRe.test(line)) break;
          if (hrRe.test(line)) break;

          // A lazy continuation can look like a setext underline after
          // list indentation is removed. Keep it in the paragraph.
          const setextContinuation = RE_SETEXT_LINE.test(nextLine) && execAt(RE_LHEADING_GFM, line + '\n' + nextLine);
          const continuation = setextContinuation
            ? '    ' + nextLineWithoutTabs.replace(/^ {0,3}/, '')
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = isBlank;

        src = src.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }

    // The loops above appended a '\n' the source may not have had. It could
    // only land on the item that exhausts src, whose raw is trimmed below,
    // and after which nothing reads endsWithBlankLine
    const raw = listSrc.slice(itemStart, taken());

    if (!list.loose) {
      // If the previous item ended with a blank line, the list is loose
      if (endsWithBlankLine) {
        list.loose = true;
      } else if (RE_DOUBLE_BLANK.test(raw)) {
        endsWithBlankLine = true;
      }
    }

    list.items.push({
      type: 'list_item',
      raw,
      task: !!RE_LIST_TASK.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }

  // Do not consume newlines at end of final item.
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    // not a list since there were no items
    return undefined;
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();

  // Item child tokens handled here at end because we needed to have the final item to trim it first
  // First pass: tokenize items and finalize list.loose from spacers before placing checkboxes
  for (const item of list.items) {
    ctx.top = false;
    item.tokens = blockTokens(item.text, [], false, ctx);

    if (!list.loose) {
      // Check if list should be loose
      const spacers = item.tokens.filter((t) => t.type === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => RE_ANY_LINE.test(t.raw));

      list.loose = hasMultipleLineBreaks;
    }
  }

  // Second pass: place task checkboxes using the final list.loose
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
      // Remove checkbox markdown from item tokens
      item.text = item.text.replace(RE_LIST_TASK_REPLACE, '');
      itemToken.raw = itemToken.raw.replace(RE_LIST_TASK_REPLACE, '');
      itemToken.text = itemToken.text.replace(RE_LIST_TASK_REPLACE, '');

      const taskRaw = RE_LIST_CHECKBOX.exec(item.raw);
      if (taskRaw) {
        const checkbox = {
          type: 'checkbox',
          raw: taskRaw[0] + ' ',
          checked: taskRaw[0] !== '[ ]',
        };
        item.checked = checkbox.checked;
        if (list.loose) {
          // The checkbox renders inside the first paragraph/text token.
          itemToken.checkbox = checkbox;
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  // Set all items to loose if list is loose
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') token.type = 'paragraph';
      }
    }
  }

  return list;
}

/**
 * The block loop. `blocks` is appended to (shared across blockquote chunks);
 * `lastParagraphClipped` merges a leading paragraph into the previous one
 * when a blockquote continues. Returns `blocks`.
 */
function blockTokens(src, blocks, lastParagraphClipped, ctx) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      bail('block: infinite loop at ' + JSON.stringify(src.slice(0, 40)));
    }

    let token;

    // newline
    if ((token = tokenSpace(src))) {
      src = src.substring(token.raw.length);
      const lastToken = blocks.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) {
        // if there's a single \n as a spacer, it's terminating the last line,
        // so move it there so that we don't get unnecessary paragraph tags
        lastToken.raw += '\n';
      } else {
        blocks.push(token);
      }
      continue;
    }

    // First-character dispatch for the structural block tokenizers. Each
    // can only match when the first non-space character (within 0-3 spaces,
    // or a tab / 4+ spaces for indented code) is its marker. Tokenizers
    // that cannot match are skipped; the relative order of the ones that
    // can is the same as marked's.
    const lead = firstNonSpaceIdx(src);
    const bch = lead < src.length ? src[lead] : '';
    if (bch === '\t' || lead >= 4) {
      // Indented code (4+ spaces, or 0-3 spaces + tab).
      if ((token = tokenCode(src))) {
        src = src.substring(token.raw.length);
        const lastToken = blocks.at(-1);
        // An indented code block cannot interrupt a paragraph.
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
        } else {
          blocks.push(token);
        }
        continue;
      }
    } else if (lead <= 3) {
      if (bch === '`' || bch === '~') {
        // fences
        if ((token = tokenFences(src))) {
          src = src.substring(token.raw.length);
          blocks.push(token);
          continue;
        }
      } else if (bch === '#') {
        // heading
        if ((token = tokenHeading(src))) {
          src = src.substring(token.raw.length);
          blocks.push(token);
          continue;
        }
      } else if (bch === '-' || bch === '*') {
        // hr, then list
        if ((token = tokenHr(src))) {
          src = src.substring(token.raw.length);
          blocks.push(token);
          continue;
        }
        if ((token = tokenList(src, ctx))) {
          src = src.substring(token.raw.length);
          blocks.push(token);
          continue;
        }
      } else if (bch === '_') {
        // hr
        if ((token = tokenHr(src))) {
          src = src.substring(token.raw.length);
          blocks.push(token);
          continue;
        }
      } else if (bch === '+') {
        // list
        if ((token = tokenList(src, ctx))) {
          src = src.substring(token.raw.length);
          blocks.push(token);
          continue;
        }
      } else if (bch >= '0' && bch <= '9') {
        // list (ordered)
        if ((token = tokenList(src, ctx))) {
          src = src.substring(token.raw.length);
          blocks.push(token);
          continue;
        }
      } else if (bch === '>') {
        // blockquote
        if ((token = tokenBlockquote(src, ctx))) {
          src = src.substring(token.raw.length);
          blocks.push(token);
          continue;
        }
      } else if (bch === '<') {
        // html
        if ((token = tokenHtml(src))) {
          src = src.substring(token.raw.length);
          blocks.push(token);
          continue;
        }
      } else if (bch === '[') {
        // def
        if ((token = tokenDef(src))) {
          src = src.substring(token.raw.length);
          const lastToken = blocks.at(-1);
          if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
            lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
            lastToken.text += '\n' + token.raw;
          } else {
            // The first definition of a label wins, but a later one still consumes its text
            if (!Object.hasOwn(ctx.links, token.tag)) {
              ctx.links[token.tag] = { href: token.href, title: token.title };
            }
            blocks.push(token);
          }
          continue;
        }
      }
    }
    // (any other first character falls through to table / lheading /
    //  paragraph / text below)
    // table (gfm)
    if ((token = tokenTable(src))) {
      src = src.substring(token.raw.length);
      blocks.push(token);
      continue;
    }

    // lheading (pre-check: skip the expensive regex unless a setext
    // underline line exists before the next blank line)
    if (hasSetextAhead(src) && (token = tokenLheading(src))) {
      src = src.substring(token.raw.length);
      blocks.push(token);
      continue;
    }

    // top-level paragraph
    if (ctx.top && (token = tokenParagraph(src))) {
      const lastToken = blocks.at(-1);
      if (lastParagraphClipped && lastToken?.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
      } else {
        blocks.push(token);
      }
      lastParagraphClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }

    // text
    if ((token = tokenText(src))) {
      src = src.substring(token.raw.length);
      const lastToken = blocks.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
      } else {
        blocks.push(token);
      }
      continue;
    }

    if (src) {
      bail('block: infinite loop at ' + JSON.stringify(src.slice(0, 40)));
    }
  }

  ctx.top = true;
  return blocks;
}

// ---------------------------------------------------------------------------
// Block rendering.
// ---------------------------------------------------------------------------

function renderCheckbox(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTableCell(cell, isHeader, links, st) {
  st.inRawBlock = false;
  const content = renderInline(cell.text, links, st);
  const type = isHeader ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderListItem(item, links, st) {
  return `<li>${renderBlocks(item.tokens, links, st)}</li>\n`;
}

/** Render block records to HTML. `links` is the complete definition map. */
function renderBlocks(blocks, links, st) {
  let out = '';
  for (const token of blocks) {
    switch (token.type) {
      case 'space': {
        break;
      }
      case 'hr': {
        out += '<hr>\n';
        break;
      }
      case 'heading': {
        st.inRawBlock = false;
        out += `<h${token.depth}>${renderInline(token.text, links, st)}</h${token.depth}>\n`;
        break;
      }
      case 'code': {
        const langString = (token.lang || '').match(RE_NOT_SPACE_START)?.[0] || '';
        // An empty code block has no content, so it must not gain a newline.
        const code = token.text ? token.text.replace(RE_ENDING_NEWLINE, '') + '\n' : '';
        if (!langString) {
          out += '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
        } else {
          out += '<pre><code class="language-'
            + escapeHtml(langString)
            + '">'
            + escapeHtml(code, true)
            + '</code></pre>\n';
        }
        break;
      }
      case 'table': {
        let header = '';
        for (const cell of token.header) header += renderTableCell(cell, true, links, st);
        header = `<tr>\n${header}</tr>\n`;
        let body = '';
        for (const row of token.rows) {
          let cellHtml = '';
          for (const cell of row) cellHtml += renderTableCell(cell, false, links, st);
          body += `<tr>\n${cellHtml}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote': {
        out += `<blockquote>\n${renderBlocks(token.tokens, links, st)}</blockquote>\n`;
        break;
      }
      case 'list': {
        let body = '';
        for (const item of token.items) body += renderListItem(item, links, st);
        const type = token.ordered ? 'ol' : 'ul';
        const startAttr = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox': {
        out += renderCheckbox(token);
        break;
      }
      case 'html': {
        out += token.text;
        break;
      }
      case 'def': {
        break;
      }
      case 'paragraph': {
        st.inRawBlock = false;
        const inner = renderInline(token.text, links, st);
        out += token.checkbox
          ? `<p>${renderCheckbox(token.checkbox)}${inner}</p>\n`
          : `<p>${inner}</p>\n`;
        break;
      }
      case 'text': {
        st.inRawBlock = false;
        const inner = renderInline(token.text, links, st);
        out += token.checkbox ? renderCheckbox(token.checkbox) + inner : inner;
        break;
      }
      default: {
        bail('block: unknown token type ' + token.type);
      }
    }
  }
  return out;
}

/** Fast path for long inputs: block pass, then render with complete links. */
function renderFast(src) {
  const ctx = { links: Object.create(null), top: true };
  const st = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
  const blocks = blockTokens(src, [], false, ctx);
  return renderBlocks(blocks, ctx.links, st);
}

/** Test hook: the fast path directly (with the same normalization). */
export function __renderFast(md) {
  return renderFast(md.replace(/\r\n|\r/g, '\n'));
}

/**
 * Entry point. Short inputs go straight to the vendored reference (spec
 * examples are short, dense with edge cases, and cost almost nothing there).
 * Long inputs go through the fast path; anything the fast path cannot
 * guarantee falls back to the reference instead of guessing.
 */
export function parse(md) {
  const src = md.replace(/\r\n|\r/g, '\n');
  if (src.length < 2000) return marked.parse(src);
  try {
    return renderFast(src);
  } catch (e) {
    if (e instanceof Bail) return marked.parse(src);
    throw e;
  }
}


