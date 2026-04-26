# Flow Auto Prompt

A Chrome extension that automates batch prompt submission to **Google Flow** (`labs.google/flow`) for both image and video generation. Paste a list of prompts, optionally attach reference images / storyboard frames, and let the extension submit them one by one — with optional auto-download of the resulting media.

## Features

- **Batch submission** — paste many prompts (one per line) and submit them with a configurable delay.
- **Image mode**
  - **Upload reference**: pick a local PNG/JPEG/WebP, uploaded once and reused across prompts.
  - **From gallery**: load existing images from Flow's `+` dropdown, multi-select frames, and cycle them across prompts (round-robin).
- **Video mode**
  - Load storyboard frames from Flow's **Bắt đầu / Start / 開始 / 시작** picker (multilingual).
  - Select frames as start references and cycle them across prompts, or leave empty for text-to-video.
- **Pipeline mode** — submit up to N prompts in flight on a single Flow tab; the next submission waits for an available slot.
- **Auto-download** — when each generated image/video appears, save it to `Downloads/<subfolder>/<prefix>_NNN.<ext>` with conflict-uniquified filenames.
- **Live progress log** — color-coded entries (info / ok / warn / err) with millisecond timestamps; bar shows completed / total.
- **Side-panel UI** — opens in Chrome's side panel, dark theme, persistent while you keep working.

## Installation

1. Clone or download this repo.
2. Open `chrome://extensions` and enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the project folder.
4. Pin the **Flow Auto Prompt** action so it's reachable from the toolbar.

## Usage

1. Open Google Flow (`https://labs.google/flow/...`) in a tab and create or open a project.
2. Click the extension icon → the side panel opens.
3. Choose a mode tab:
   - **🖼 Image** — paste prompts, optionally upload a reference or load gallery frames.
   - **🎬 Video** — switch the Flow page to **Video** mode (the **Bắt đầu** button must be visible), then click **⟳ Load from Flow** to import storyboard frames.
4. Paste prompts (one per line) into the textarea.
5. Set:
   - **Delay between prompts (s)** — submit gap, default `30`, min `5`, max `120`.
   - **Threads** — max in-flight generations (`1`–`10`). Higher = more parallel jobs on the same tab.
6. (Optional) Tick **Auto-download to folder**, set a subfolder and filename prefix.
7. Click **▶ Start**. Watch the log; click **■ Stop** to abort the submit loop (in-flight jobs continue).

### Frame mapping rules

When fewer frames are selected than prompts:

| Selection vs prompts | Behavior |
|---|---|
| 0 selected | Text-only (no reference) |
| `sel == promptCount` | 1:1 mapping |
| `sel < promptCount` | Round-robin cycle |
| `sel > promptCount` | Only first `promptCount` used |

The mapping is previewed under the grid (`Prompt → Frame`) before you hit Start.

## How it works

The extension is built on **Manifest V3** with a service worker (`background.js`) and a side-panel UI (`popup.html` / `popup.js`).

- **Page injection (`world: 'MAIN'`)** — `chrome.scripting.executeScript` runs functions directly on the Flow page so they can interact with React's Slate editor and Radix portal popups (see `submitPromptInPage`, `submitVideoPromptInPage`, `fetchStoryboardInPage`).
- **Trusted UI events** — `realClick(el)` dispatches the full pointer/mouse event sequence (`pointerover` → `pointerdown` → `mousedown` → `pointerup` → `mouseup` → `click`) so React state updates fire as if a human clicked.
- **Slate prompt injection** — uses `beforeinput` with `inputType: 'insertText'`, falling back to `execCommand('insertText')` if Slate ignores the event.
- **Popup scoping** — multiple Radix portals can be open; the extension picks the dropdown by detecting the Virtuoso list with small (40–100 px) items, so it doesn't accidentally interact with Flow's persistent sidebar media library.
- **UUID-resolved frames** — every gallery frame is keyed by the UUID extracted from `media.getMediaUrlRedirect?name=<uuid>`, so insertions or reorderings between Load and Submit don't break selections. Falls back to dropdown index if the UUID isn't present in the current viewport.
- **Lazy scroll-loading** — when a target UUID isn't in the dropdown's visible range, the extension scrolls the Virtuoso list to the bottom (with stability checks) until the item appears.
- **Pipeline / in-flight tracking** — `snapshotMediaInPage` captures all media UUIDs ≥200 px wide on the page; a 1.5 s background watcher diffs against `knownUuids` and pairs each newly-arrived UUID with the oldest pending submission (FIFO).
- **Auto-download** — uses `chrome.downloads.download` with `conflictAction: 'uniquify'` once a UUID matches a pending entry; extension is `mp4` for video mode, `png` for image.

## Permissions

| Permission | Why |
|---|---|
| `activeTab`, `tabs` | Find the active Flow tab and inject scripts into it. |
| `scripting` | Run page functions in the `MAIN` world to drive the Flow UI. |
| `storage` | Reserved for future settings persistence. |
| `clipboardRead`, `clipboardWrite` | Reserved for clipboard prompt import. |
| `windows` | Locate Flow tabs across multiple windows. |
| `sidePanel` | Render the popup as a side panel. |
| `downloads` | Save generated images/videos when auto-download is enabled. |
| host: `https://labs.google/*`, `https://*.google.com/*` | Inject into Flow pages. |

## File layout

```
flow-auto-prompt/
├── manifest.json         # MV3 manifest, side panel + permissions
├── background.js         # Service worker (side-panel open handler)
├── popup.html            # Side-panel UI markup + styles
├── popup.js              # All logic — UI wiring, page injection, pipeline runner
└── icons/                # 16/32/48/128 px action icons
```

## Limitations

- Designed for the current Google Flow DOM. If Google updates the Flow UI (Slate editor, Radix popups, button labels) the selectors in `SEL` and the frame-button text lists may need refreshing.
- Multilingual frame button text is currently `vi / en / ja / ko` — add more in `SEL.VIDEO_START_TEXTS` / `VIDEO_END_TEXTS` if needed.
- Image-completion timeout is hard-coded to ~90 s in the upload-spinner check; very large generations may need tuning.
- Single-tab pipeline only (no multi-tab parallelism); the **Threads** setting controls how many submissions can be in flight on one tab.
