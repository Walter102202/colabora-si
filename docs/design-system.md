# colabora.si design system

Use this page for anything visual: product UI, landing pages, emails, slides, social images and video.

The values below come from `app/globals.css` (workspace) and `components/landing/landing.css` (public pages). Those files win if they ever differ. When you change a token there, change it here too.

## Identity

- **Name:** always lowercase, `colabora.si`. Never "Colabora" or "Colabora.si".
- **Wordmark:** the text `colabora.si` in Inter 700 with tight tracking (24 px with -1 px in the landing). `colabora` takes the text color and `.si` the blue.
- **Promise:** "Your team. Your agents. On the same page."
- **Supporting line:** "People and AI agents. One shared place to work."
- **Character:** warm, calm and clear. A soft, friendly character sits next to a quiet, paper-like editorial page.
- **Language:** English only, in the interface and in Trama's fixed strings.

## Two surfaces

| Surface | Used for | Look |
|---|---|---|
| Public | Landing, `/set-password`, emails, video, social, slides | Warm paper, Newsreader headlines, Inter text |
| Workspace | The app itself | Clean white page, system font, content first |

## Public colors

| Role | Light | Dark |
|---|---|---|
| Background (paper) | `#f7f7f3` | `#181a1b` |
| Card (white) | `#ffffff` | `#212426` |
| Soft fill | `#eeeee8` | `#292c2e` |
| Heading | `#1b1a17` | `#f7f6f1` |
| Text (ink) | `#37352f` | `#eeece5` |
| Muted text | `#6c6b63` | `#b3b3aa` |
| Line | `#dfdfd7` | `#3c4142` |
| Blue (text, emphasis) | `#196eb9` | `#88c3f7` |
| Blue soft fill | `#eaf3fb` | `#223e53` |
| Button | `#176bb5` with `#ffffff` text | `#88c3f7` with `#142838` text |
| Brand blue (dots, focus) | `#2383e2` | `#2383e2` |
| Bad | `#a3341f` | `#f2a593` |

Task states, always as a soft fill with matching text:

| State | Light fill / text | Dark fill / text |
|---|---|---|
| Working | `#e2ebfb` / `#1d4ed8` | `#22314d` / `#93c5fd` |
| Review | `#dcebfa` / `#1461ad` | `#1f3d57` / `#88c3f7` |
| Decision | `#fff5da` / `#80611e` | `#473e26` / `#ebce81` |
| Done | `#eef6f0` / `#2c7154` | `#243c30` / `#9bd5b6` |

Blue is the only accent.

## Workspace colors

| Role | Light | Dark |
|---|---|---|
| Background | `#ffffff` | `#191919` |
| Secondary background | `#f7f7f5` | `#202020` |
| Text | `#37352f` | `#d4d4d4` |
| Accent | `#2383e2` | `#2383e2` |

Secondary text, borders and hover states are transparent versions of the text color. User colors for text and blocks are the `--c-*` and `--bgc-*` tokens in `app/globals.css`. Use the tokens instead of hex values in product code.

## Type

| Use | Public | Workspace |
|---|---|---|
| Headlines | Newsreader 400, tracking -0.045em, line height about 1.02 | System font 700 |
| Emphasis in a headline | Newsreader italic in blue | Not used |
| Body and interface | Inter 400 to 700 | System font |
| Small label | Inter 600, uppercase, tracking 0.1em to 0.13em, in blue or muted | Not used |
| Code | Not used | System monospace |

- Font files are in `public/fonts/` (Inter and Newsreader, both under the OFL). Load them with `@font-face`.
- Public sizes at full width: H1 up to 72 px, H2 about 53 px, lede 19 px, body 17 px, interface 15 px, label 13 px.
- Workspace sizes: page title 40 px, body 16 px, headings 30, 24 and 20 px, interface 14 px.

## Shape and depth

- **Radius:** 6 px for workspace controls, 7 px for public buttons, 12 px for windows and large cards, 999 px for pills.
- **Lines:** 1 px in the line color.
- **Shadow:** soft and low contrast. Public windows use `0 12px 40px #2c2b2514`. Workspace menus use the `--shadow` token.

## Trama

Trama is the workspace's own agent and the face of the product. Its image is approved exactly as it is.

**Never** tint, filter, crop, mask, compress, regenerate, redraw, flip or stretch it. Do not animate its parts: no blinking, no moving arm, nothing placed on top of it.

**Allowed:** move, rotate or scale the whole image, keeping its proportions. Anything else, such as a state, a shadow, a bubble or a motion mark, goes outside the character as a separate element.

- **Served files:** `public/brand/trama/v1/` at 64, 128, 256 and 512 px, with a transparent background. Never display them above their pixel size.
- **In code:** use `TRAMA` from `lib/tramaIdentity.ts`, through `TramaAvatar` in the workspace and `TramaImage` in the landing.
- **Master:** the 948 px master stays outside this repository with the maintainer. Ask for it when a piece needs more than 512 px.
- **Alt text:** "Trama, the agent of this workspace", or empty when it is decorative.
- **Background:** Trama works on paper, white and dark.
- **Covers:** `public/brand/trama/covers/v1/` holds the page covers (On the same page, Gardener, Chef, Detective, Conductor, Explorer). Treat them as finished images too.
- **Voice:** first person, brief and warm. Trama proposes and the person decides. It never claims to act without confirmation.
- **Model credit:** "Powered by Muse Wonder, Meta's AI model." Voice is transcribed with Muse.

## Other images

- **Social card:** `public/brand/og-card.png` (1200x630).
- **Favicons:** `public/favicon.ico` and `public/favicon-32.png`.
- **Third-party logos:** `public/brand/agents/` and `public/brand/connectors/`. They belong to their owners and stay unmodified. Each folder's `NOTICE.txt` lists the sources. Add new ones there with their source.

## Motion

- Motion is short and has a reason: elements land with a soft spring, and lines draw themselves.
- Move Trama as a whole, following the rule above.
- Animations in the product must respect `prefers-reduced-motion`.
- For video: hard cuts, at most one slow push-in per scene, and text of at least 28 px at 1080p.

## Product UI

- Use native controls with visible labels or `aria-label`.
- The main action is a filled button in the accent color. The second action is outlined next to it, as in **Do it** and **Not now**.
- Icons come from `lucide-react`.
- Agent views are pure components in `components/agents/panel/`, so the workspace and the MCP Apps card share one look.
