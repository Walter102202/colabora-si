const SYMBOLS: Record<string, string> = {
  "alpha": "α",
  "beta": "β",
  "gamma": "γ",
  "delta": "δ",
  "epsilon": "ε",
  "varepsilon": "ε",
  "zeta": "ζ",
  "eta": "η",
  "theta": "θ",
  "vartheta": "ϑ",
  "iota": "ι",
  "kappa": "κ",
  "lambda": "λ",
  "mu": "μ",
  "nu": "ν",
  "xi": "ξ",
  "omicron": "ο",
  "pi": "π",
  "varpi": "ϖ",
  "rho": "ρ",
  "varrho": "ϱ",
  "sigma": "σ",
  "varsigma": "ς",
  "tau": "τ",
  "upsilon": "υ",
  "phi": "ϕ",
  "varphi": "φ",
  "chi": "χ",
  "psi": "ψ",
  "omega": "ω",
  "Gamma": "Γ",
  "Delta": "Δ",
  "Theta": "Θ",
  "Lambda": "Λ",
  "Xi": "Ξ",
  "Pi": "Π",
  "Sigma": "Σ",
  "Upsilon": "Υ",
  "Phi": "Φ",
  "Psi": "Ψ",
  "Omega": "Ω",
  "times": "×",
  "div": "÷",
  "cdot": "·",
  "pm": "±",
  "mp": "∓",
  "ast": "∗",
  "star": "⋆",
  "setminus": "∖",
  "circ": "∘",
  "bullet": "•",
  "oplus": "⊕",
  "ominus": "⊖",
  "otimes": "⊗",
  "odot": "⊙",
  "boxtimes": "⊠",
  "leq": "≤",
  "le": "≤",
  "geq": "≥",
  "ge": "≥",
  "neq": "≠",
  "ne": "≠",
  "approx": "≈",
  "equiv": "≡",
  "sim": "∼",
  "simeq": "≃",
  "cong": "≅",
  "propto": "∝",
  "ll": "≪",
  "gg": "≫",
  "perp": "⊥",
  "parallel": "∥",
  "mid": "∣",
  "in": "∈",
  "notin": "∉",
  "ni": "∋",
  "subset": "⊂",
  "supset": "⊃",
  "subseteq": "⊆",
  "supseteq": "⊇",
  "cup": "∪",
  "cap": "∩",
  "emptyset": "∅",
  "varnothing": "∅",
  "forall": "∀",
  "exists": "∃",
  "nexists": "∄",
  "land": "∧",
  "wedge": "∧",
  "lor": "∨",
  "vee": "∨",
  "neg": "¬",
  "lnot": "¬",
  "therefore": "∴",
  "because": "∵",
  "top": "⊤",
  "bot": "⊥",
  "leftarrow": "←",
  "gets": "←",
  "leftrightarrow": "↔",
  "Rightarrow": "⇒",
  "Leftarrow": "⇐",
  "Leftrightarrow": "⇔",
  "mapsto": "↦",
  "uparrow": "↑",
  "downarrow": "↓",
  "sum": "∑",
  "prod": "∏",
  "coprod": "∐",
  "int": "∫",
  "oint": "∮",
  "iint": "∬",
  "iiint": "∭",
  "infty": "∞",
  "partial": "∂",
  "nabla": "∇",
  "angle": "∠",
  "ldots": "…",
  "dots": "…",
  "cdots": "⋯",
  "vdots": "⋮",
  "ddots": "⋱",
  "Re": "ℜ",
  "Im": "ℑ",
  "aleph": "ℵ",
  "hbar": "ℏ",
  "ell": "ℓ",
  "wp": "℘",
  "prime": "′",
  "dagger": "†",
  "ddagger": "‡",
  "checkmark": "✓",
  "surd": "√",
  "colon": ":",
  "langle": "⟨",
  "rangle": "⟩",
  "lceil": "⌈",
  "rceil": "⌉",
  "lfloor": "⌊",
  "rfloor": "⌋",
  "quad": " ",
  "qquad": "  "
};
const FUNCS = new Set(["sin","cos","tan","cot","sec","csc","arcsin","arccos","arctan","sinh","cosh","tanh","log","ln","lg","exp","lim","max","min","sup","inf","det","dim","ker","gcd","deg","arg","Pr","mod"]);

function esc(c: string): string {
  if (c === "&") return "&amp;";
  if (c === "<") return "&lt;";
  if (c === ">") return "&gt;";
  if (c === '"') return "&quot;";
  return c;
}

export function renderMath(src: string): string {
  const s = src ?? "";
  let i = 0;

  // `stop`: "}" dentro de un grupo, "]" dentro del índice de \sqrt, null en el nivel superior.
  const renderUntil = (stop: "}" | "]" | null): string => {
    let out = "";
    while (i < s.length) {
      const c = s[i];
      if (c === stop) break;
      if (c === "}") { i++; continue; }            // llave de cierre huérfana: se ignora
      if (c === "{") {
        i++;
        out += renderUntil("}");
        if (s[i] === "}") i++;
        continue;
      }
      if (c === "^") { i++; out += `<sup>${renderGroup()}</sup>`; continue; }
      if (c === "_") { i++; out += `<sub>${renderGroup()}</sub>`; continue; }
      if (c === "\\") { out += renderCommand(); continue; }
      out += esc(c);
      i++;
    }
    return out;
  };

  const renderGroup = (): string => {
    if (s[i] === "{") {
      i++;
      const inner = renderUntil("}");
      if (s[i] === "}") i++;
      return inner;
    }
    if (s[i] === "\\") return renderCommand();
    const c = s[i] ?? "";
    i++;
    return esc(c);
  };

  const readName = (): string => {
    let name = "";
    while (i < s.length && /[a-zA-Z]/.test(s[i])) { name += s[i]; i++; }
    return name;
  };

  const renderCommand = (): string => {
    i++; // salta la barra
    if (i < s.length && !/[a-zA-Z]/.test(s[i])) {
      const c = s[i];
      i++;
      if (c === ",") return " ";
      if (c === ";" || c === ":") return " ";
      if (c === " ") return " ";
      if (c === "\\") return "<br/>";
      return esc(c);
    }
    const name = readName();
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const num = renderGroup();
      const den = renderGroup();
      return `<span class="math-frac"><span class="math-num">${num}</span><span class="math-den">${den}</span></span>`;
    }
    if (name === "sqrt") {
      let index = "";
      if (s[i] === "[") {
        i++;
        index = renderUntil("]");
        if (s[i] === "]") i++;
      }
      const rad = renderGroup();
      const idx = index ? `<span class="math-sqrt-index">${index}</span>` : "";
      return `<span class="math-sqrt">${idx}<span class="math-sqrt-sign">√</span><span class="math-sqrt-rad">${rad}</span></span>`;
    }
    if (name === "text" || name === "mathrm" || name === "operatorname" ||
        name === "mathbf" || name === "mathit" || name === "mathbb" || name === "mathcal") {
      const g = renderGroup();
      const style = name === "mathbf" ? "font-weight:600;font-style:normal"
                  : name === "mathit" ? "font-style:italic"
                  : "font-style:normal";
      return `<span style="${style}">${g}</span>`;
    }
    if (name === "left" || name === "right") {
      if (s[i] === "\\") {
        i++;
        if (/[a-zA-Z]/.test(s[i] ?? "")) {
          const named = readName();
          return named in SYMBOLS ? esc(SYMBOLS[named]) : esc(named);
        }
        const escaped = s[i] ?? "";
        i++;
        return esc(escaped);
      }
      const d = s[i] ?? "";
      i++;
      return d === "." ? "" : esc(d);
    }
    if (name === "hat" || name === "bar" || name === "vec" ||
        name === "tilde" || name === "dot" || name === "overline") {
      const g = renderGroup();
      const acc = name === "hat" ? "ˆ" : name === "bar" || name === "overline" ? "‾"
                : name === "vec" ? "→" : name === "tilde" ? "˜" : "˙";
      return `<span class="math-acc"><span class="math-acc-mark">${acc}</span>${g}</span>`;
    }
    if (FUNCS.has(name)) return `<span style="font-style:normal">${name}</span>`;
    if (name in SYMBOLS) return esc(SYMBOLS[name]);
    return esc(name);
  };

  return renderUntil(null);
}
