# Aegis interface design

Aegis presents one operating wallet, its ETH reserve, and the controls for preparing a payment. The visual hierarchy follows that task: identify the wallet, understand its balance, review a proposed top-up, and explicitly confirm execution.

## Composition

The signed-out view introduces the product with restrained typography, warm-white space, and the original ceramic Aegis artwork. Keep the connection action prominent and distinguish a local development wallet from an external wallet.

The signed-in view is a working wallet application. Use a slim horizontal navigation bar on desktop. Place the graphite wallet card beside the reserve editor, then show supporting balances, the task ledger, and the request composer. Give the balance and next available action more emphasis than technical metadata. Preserve direct access to Operations, Approvals, Verification, and Settings.

At narrow widths, use one column and bottom navigation. Place the wallet before its reserve controls. Let long records wrap or scroll within their own region; the page must not scroll horizontally. Confirmation drawers become full-width surfaces with reachable actions and room for the on-screen keyboard.

## Color and themes

Use semantic CSS variables in `src/style.css`. Keep the graphite wallet card in both themes; changing the surrounding canvas should not invert the card artwork.

- Light: `--bg: #f4f3ef`, `--panel: #ffffff`, `--text: #222624`, `--muted: #666d69`, `--sage: #4f6b5a`, `--rule: #deded8`.
- Dark: `--bg: #121314`, `--panel: #1b1d1f`, `--text: #f3f4f3`, `--muted: #adb4af`. Use theme-specific rules, controls, and accents with readable contrast.
- Sage identifies ordinary interactive emphasis. Green means a successful or healthy state, amber means attention or approval, and red means failure or refusal. Always pair these colors with text.
- Use opaque surfaces for modals, drawers, menus, and notifications. Keep loading, offline, disabled, and error states legible in both themes.

The light/dark control is an appearance preference. `src/theme.ts` applies `data-theme` to the document root and stores a valid choice under `aegis.ui.theme.v1`. The default is light. A storage failure must leave the current page usable. Theme changes must preserve the active view, form values, drafts, and pending payment state.

## Type, spacing, and shape

Use the platform system sans-serif stack with explicit Chinese fallbacks: Segoe UI, PingFang SC, Microsoft YaHei UI / Microsoft YaHei, and Noto Sans SC. Use system monospace for addresses, hashes, block numbers, and other identifiers. No downloaded proprietary font is required.

Keep ordinary interface text at approximately 14px and supporting labels at least 12px. Use larger, tabular numerals for the wallet balance. Allow Chinese labels to wrap naturally; avoid tightly tracked CJK text and all-capital technical labels as decoration.

Use the spacing scale 4, 8, 12, 16, 24, and 32px. Major wallet and editor surfaces use an 18px radius; controls use 10px. Prefer surface contrast and fine rules over nested cards or heavy shadows. Icons share a consistent stroke, size, and alignment and accompany meaningful labels.

## Assets and motion

`public/wallet-material.png` supplies the original graphite Aegis material on the wallet card. `public/aegis-hero.png` supplies the warm-white introductory artwork. Keep both assets proportional and decorative: essential balances, addresses, and actions remain real text and controls.

Use brief feedback for hover, focus, and loading. Financial panels and confirmation content appear immediately, without opacity entrance animations. Respect `prefers-reduced-motion`; never rely on movement to explain payment status.

## Financial information and interaction

- Display unavailable observations as unavailable, never as a zero balance. Include the observed chain, block, and time when available.
- A shortened identifier must have an accessible route to its complete value. Preserve exact ETH amounts in review and evidence views; a rounded display must not change the underlying amount.
- Reserve thresholds and targets are browser preferences. Present suggestions separately from enforced contract policy.
- Preparing a draft or opening a preview does not pay. Preserve the explicit confirmation step and any required Owner authorization.
- A prepared amount must remain bound to its recipient and chain. Refreshing a view or changing a theme must not submit a second transaction.
- Show actual task and receipt states. Do not invent spending charts, gas histories, transaction counts, activity, or verified badges to fill empty space.

## Accessibility and acceptance

Controls need visible labels, keyboard focus, and distinct disabled states. Icon-only actions need accessible names. Use at least 44px touch targets on mobile. Maintain readable contrast for text, fields, focus indicators, and all status colors.

Review signed-out, connected, low-reserve, healthy, loading, offline, error, preview, approval, and completed states in both themes. Check desktop at 1440px and mobile at 390px and 320px, including long addresses and Chinese labels. Confirm that navigation, scrolling, dialogs, form input, and the final confirmation remain usable without horizontal page overflow. Run the existing functional checks after layout changes; visual inspection complements those checks.

## Design references

[Apple Wallet](https://www.apple.com/wallet/) informs the emphasis on a recognizable wallet object, clear balances, and concise actions. The [Apple design analysis in awesome-design-md](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/apple/DESIGN.md) informs the restrained use of imagery, space, typography, and surface contrast. These references guide the composition; Aegis uses its own artwork, palette, content, and controls.
