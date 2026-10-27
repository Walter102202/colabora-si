function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const KEYWORDS: Record<string, string[]> = {
  "javascript": [
    "const",
    "let",
    "var",
    "function",
    "return",
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "class",
    "extends",
    "super",
    "new",
    "this",
    "typeof",
    "instanceof",
    "in",
    "of",
    "try",
    "catch",
    "finally",
    "throw",
    "async",
    "await",
    "yield",
    "import",
    "export",
    "from",
    "default",
    "delete",
    "void",
    "static",
    "get",
    "set"
  ],
  "typescript": [
    "const",
    "let",
    "var",
    "function",
    "return",
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "class",
    "extends",
    "implements",
    "interface",
    "type",
    "enum",
    "namespace",
    "super",
    "new",
    "this",
    "typeof",
    "instanceof",
    "keyof",
    "in",
    "of",
    "try",
    "catch",
    "finally",
    "throw",
    "async",
    "await",
    "yield",
    "import",
    "export",
    "from",
    "default",
    "delete",
    "void",
    "static",
    "public",
    "private",
    "protected",
    "readonly",
    "abstract",
    "get",
    "set",
    "as",
    "is",
    "satisfies"
  ],
  "python": [
    "def",
    "return",
    "if",
    "elif",
    "else",
    "for",
    "while",
    "break",
    "continue",
    "class",
    "import",
    "from",
    "as",
    "try",
    "except",
    "finally",
    "raise",
    "with",
    "lambda",
    "yield",
    "global",
    "nonlocal",
    "pass",
    "assert",
    "del",
    "async",
    "await",
    "and",
    "or",
    "not",
    "in",
    "is"
  ],
  "java": [
    "public",
    "private",
    "protected",
    "class",
    "interface",
    "extends",
    "implements",
    "return",
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "new",
    "this",
    "super",
    "static",
    "final",
    "void",
    "try",
    "catch",
    "finally",
    "throw",
    "throws",
    "import",
    "package",
    "abstract",
    "synchronized",
    "volatile",
    "enum",
    "instanceof"
  ],
  "c": [
    "int",
    "char",
    "float",
    "double",
    "long",
    "short",
    "unsigned",
    "signed",
    "void",
    "struct",
    "union",
    "enum",
    "typedef",
    "const",
    "static",
    "extern",
    "return",
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "sizeof",
    "goto",
    "default"
  ],
  "cpp": [
    "int",
    "char",
    "float",
    "double",
    "long",
    "short",
    "unsigned",
    "signed",
    "void",
    "bool",
    "struct",
    "class",
    "union",
    "enum",
    "typedef",
    "const",
    "constexpr",
    "static",
    "extern",
    "return",
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "sizeof",
    "new",
    "delete",
    "template",
    "typename",
    "namespace",
    "using",
    "public",
    "private",
    "protected",
    "virtual",
    "override",
    "this",
    "nullptr",
    "auto",
    "try",
    "catch",
    "throw"
  ],
  "csharp": [
    "using",
    "namespace",
    "class",
    "struct",
    "interface",
    "enum",
    "public",
    "private",
    "protected",
    "internal",
    "static",
    "readonly",
    "const",
    "void",
    "return",
    "if",
    "else",
    "for",
    "foreach",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "new",
    "this",
    "base",
    "try",
    "catch",
    "finally",
    "throw",
    "async",
    "await",
    "var",
    "get",
    "set",
    "is",
    "as",
    "null",
    "true",
    "false"
  ],
  "go": [
    "package",
    "import",
    "func",
    "return",
    "if",
    "else",
    "for",
    "range",
    "switch",
    "case",
    "break",
    "continue",
    "var",
    "const",
    "type",
    "struct",
    "interface",
    "map",
    "chan",
    "go",
    "defer",
    "select",
    "default",
    "nil",
    "true",
    "false"
  ],
  "rust": [
    "fn",
    "let",
    "mut",
    "const",
    "return",
    "if",
    "else",
    "for",
    "while",
    "loop",
    "match",
    "struct",
    "enum",
    "impl",
    "trait",
    "pub",
    "use",
    "mod",
    "crate",
    "self",
    "super",
    "as",
    "ref",
    "move",
    "async",
    "await",
    "dyn",
    "where",
    "type",
    "unsafe",
    "true",
    "false"
  ],
  "ruby": [
    "def",
    "end",
    "return",
    "if",
    "elsif",
    "else",
    "unless",
    "for",
    "while",
    "until",
    "do",
    "begin",
    "rescue",
    "ensure",
    "class",
    "module",
    "require",
    "yield",
    "then",
    "case",
    "when",
    "nil",
    "true",
    "false",
    "self",
    "attr_accessor",
    "attr_reader",
    "attr_writer"
  ],
  "php": [
    "function",
    "return",
    "if",
    "else",
    "elseif",
    "for",
    "foreach",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "class",
    "interface",
    "extends",
    "implements",
    "new",
    "public",
    "private",
    "protected",
    "static",
    "const",
    "echo",
    "print",
    "use",
    "namespace",
    "try",
    "catch",
    "finally",
    "throw",
    "null",
    "true",
    "false"
  ],
  "sql": [
  "select",
  "from",
  "where",
  "insert",
  "into",
  "values",
  "update",
  "set",
  "delete",
  "create",
  "table",
  "drop",
  "alter",
  "add",
  "primary",
  "key",
  "foreign",
  "references",
  "join",
  "inner",
  "left",
  "right",
  "outer",
  "on",
  "group",
  "by",
  "order",
  "having",
  "limit",
  "offset",
  "distinct",
  "as",
  "and",
  "or",
  "not",
  "null",
  "like",
  "in",
  "between",
  "union",
  "index",
  "view"
],
  "bash": [
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "for",
    "while",
    "do",
    "done",
    "case",
    "esac",
    "function",
    "return",
    "in",
    "select",
    "until",
    "echo",
    "export",
    "local",
    "read",
    "cd",
    "exit"
  ]
};
const BOOLEANS = new Set(["true", "false", "null", "nil", "None", "True", "False", "undefined"]);
const CASE_INSENSITIVE_KEYWORDS = new Set(["sql"]);

function commentStyle(lang: string): { line: RegExp | null; block: boolean } {
  switch (lang) {
    case "python": case "ruby": case "bash": case "yaml":
      return { line: /#[^\n]*/y, block: false };
    case "sql":
      return { line: /--[^\n]*/y, block: true };
    case "html": case "markdown": case "plaintext": case "text":
      return { line: null, block: false };
    default:
      return { line: /\/\/[^\n]*/y, block: true };
  }
}

export function highlightCode(src: string, language?: string): string {
  const lang = (language ?? "plaintext").toLowerCase();
  if (lang === "plaintext" || lang === "text") return esc(src);
  const keywords = new Set(KEYWORDS[lang] ?? []);
  const foldCase = CASE_INSENSITIVE_KEYWORDS.has(lang);
  const { line: lineRe, block: hasBlock } = commentStyle(lang);

  let out = "";
  let i = 0;
  const n = src.length;
  const span = (cls: string, text: string) => `<span class="${cls}">${esc(text)}</span>`;

  while (i < n) {
    const ch = src[i];

    if (hasBlock && ch === "/" && src[i + 1] === "*") {          // comentario de bloque
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;                      // sin cierre: hasta el final
      out += span("tok-comment", src.slice(i, stop));
      i = stop;
      continue;
    }
    if (lineRe) {                                                 // comentario de línea
      lineRe.lastIndex = i;
      const m = lineRe.exec(src);
      if (m && m.index === i) {
        out += span("tok-comment", m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === "`") {                 // cadenas
      let j = i + 1;
      while (j < n && src[j] !== ch) {
        if (src[j] === "\\") j++;                                 // salta el carácter escapado
        j++;
      }
      j = Math.min(j + 1, n);                                     // sin cierre: hasta el final
      out += span("tok-string", src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {   // números
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxX._]/.test(src[j])) j++;        // 0xFF, 1e3, .5, 1_000
      out += span("tok-number", src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_$@]/.test(ch)) {                                 // identificadores
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const lookup = foldCase ? word.toLowerCase() : word;
      if (keywords.has(lookup)) out += span("tok-keyword", word);
      else if (BOOLEANS.has(lookup)) out += span("tok-boolean", word);
      else if (src[j] === "(") out += span("tok-fn", word);
      else out += esc(word);
      i = j;
      continue;
    }
    out += esc(ch);                                               // resto: espacios, puntuación
    i++;
  }
  return out;
}
