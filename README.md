# Mira

[简体中文](README.zh-CN.md) · English

Make parts of a picture appear one after another. Useful for whiteboard drawings, step-by-step guides, and illustrations.

## Just want to use it?

[Open Mira](https://www.jhstore.cn/mira/)

Open the page and upload a picture. No account, installation, or API key needed. If you do not have a picture ready, click **载入双图案例演示** to try the two included examples.

The online version sends your images to the server for processing. If you want the images to stay on your computer, use the local version below.

![An animation exported with Mira](docs/examples/mira-preview.gif)

This is a smaller preview. [Download the full-size GIF](docs/examples/mira-demo.gif).

## Make your first animation

1. Upload a PNG, JPG, or WebP. Mira adds selection outlines automatically.
2. If an outline is wrong, select it in the list and drag the blue dots. Draw extra regions with the rectangle or freeform tool.
3. Drag a whole row up or down to change when it appears. You do not need to aim for a small handle.
4. Click **播放** below the picture to preview. Choose MP4 or GIF in the top-right corner, then export. The finished file downloads automatically.

Want to edit it again later? Click **保存项目**. This saves a JSON file containing your pictures and edits. Open that file next time with **打开项目**.

MP4 is a silent video. GIF loops. Both keep your animations and transitions, with the long edge set to 1920 pixels.

## A few controls you may need

- The blue dots adjust selection edges. **选择 / 移动** moves the whole selection.
- **清空框选** removes the current picture's selections. Undo restores them.
- **自动排时** sets the timing from the current list order. You can also edit each region's start time and duration.
- **整图末位** reveals the rest of the picture at the end. It stays last.
- Space plays or pauses; Esc returns to editing; ⌘/Ctrl+Z undoes the last change.

Whiteboard-style images with a plain background work best. If automatic selection misses something, adjust it by hand. **目标内容区域数** can be left blank.

## Run it on your own computer

[Download the source ZIP](https://github.com/XiesRay/Mira/archive/refs/heads/main.zip) and unzip it.

- Double-click **Open Mira.html** to open the online version. This does not need a local setup.
- On a Mac, double-click **Start Mira.command** to start the local version. It checks your setup, prepares the project, and opens your browser.

The local version currently supports macOS and Linux. It needs Python 3.11+, Node.js 22.20+ with npm, and FFmpeg. The launcher installs the project's Python and npm packages, but does not install these system tools for you. The first setup needs internet access; after that, local editing and export can work offline.

If you prefer a terminal:

```sh
git clone https://github.com/XiesRay/Mira.git
cd Mira
python3 scripts/start.py
```

The page opens at `http://127.0.0.1:4317`. Use `--port 4318` if that port is taken, or `--no-open` to open the browser yourself. Stop it with `python3 scripts/stop.py`.

## Let an agent open it

For agents supported by the [Skills installer](https://github.com/vercel-labs/skills):

```sh
npx skills add XiesRay/Mira
```

Then ask the agent to open Mira. If your agent reads files and runs commands but does not support skills, point it at [SKILL.md](SKILL.md). The same app works without an agent.

## Where your work goes

The online version processes images on the server. The local version sends them only to the service on your own computer. Neither version saves your editable project to a cloud account. Save the project JSON before closing the page.

Each project can hold 30 pictures, with 100 regions per picture. Pictures must fit within 20 MB and 40 megapixels; a project JSON can be up to 80 MB. Exports can be up to 10 minutes. Export makes PNG copies of the images, so those copies must also fit within the file limits.

For code changes and server maintenance, see [the deployment notes](docs/deployment.md).

## License

[MIT](LICENSE). The two example pictures and documentation are included. Third-party dependencies keep their own licenses.
