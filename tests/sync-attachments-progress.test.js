const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(
    path.join(__dirname, "../scripts/sync-attachments.js"), "utf8"
);
const marker = "\n(async () => {";

function fixture() {
    const windows = [];
    class FakeProgressWindow {
        constructor() {
            this.headlines = [];
            this.events = [];
            this.descriptions = [];
            this.ItemProgress = class {
                constructor(_icon, value) {
                    this.text = value;
                    this.progress = null;
                    this.history = [];
                }
                setText(value) { this.text = value; }
                setProgress(value) { this.progress = value; this.history.push(value); }
            };
            windows.push(this);
        }
        changeHeadline(value) { this.headlines.push(value); }
        show() { this.events.push("show"); }
        addDescription(value) { this.descriptions.push(value); }
        startCloseTimer(value) { this.events.push("timer:" + value); }
    }
    const context = vm.createContext({
        Zotero: { ProgressWindow: FakeProgressWindow, logError() {} },
        Services: { env: { get: key => key === "CHEN_GROUP_API_KEY_MEMBER" ? "token" : "" } },
    });
    vm.runInContext(script.slice(0, script.indexOf(marker)), context);
    return { context, windows };
}

test("启动即显示进度，处理每篇文献更新百分比，结束沿用同一个窗口", () => {
    const { context, windows } = fixture();
    const start = vm.runInContext("createBatchProgress", context);
    const update = vm.runInContext("updateBatchProgress", context);
    const finish = vm.runInContext("showSummary", context);
    const batch = start();
    assert.equal(windows.length, 1);
    assert.deepEqual(windows[0].events, ["show"]);
    assert.equal(batch.statusLine.progress, 0);
    batch.total = 3;
    batch.active = 2;
    update(batch, "正在处理 SI");
    assert.equal(batch.statusLine.progress, 0);
    assert.match(batch.titleLine.text, /SI/);
    batch.completed = 1;
    update(batch, "文献 A 已处理");
    assert.equal(batch.statusLine.progress, 33);
    batch.completed = 2;
    update(batch, "文献 B 已处理");
    assert.equal(batch.statusLine.progress, 66);
    batch.completed = 3;
    batch.active = 0;
    finish(batch, { total: 3, updated: 5, failed: 0, issues: [] });
    assert.equal(batch.statusLine.progress, 100);
    assert.match(batch.titleLine.text, /附件更新 5/);
    assert.equal(windows.length, 1);
    assert.deepEqual(windows[0].events, ["show", "timer:5000"]);
    assert.deepEqual(batch.statusLine.history, [0, 0, 33, 66, 100]);
});

test("出错详情保留并进行 HTML 转义，窗口不自动关闭", () => {
    const { context, windows } = fixture();
    const batch = vm.runInContext("createBatchProgress", context)();
    vm.runInContext("showSummary", context)(
        batch,
        { total: 1, updated: 0, failed: 1, issues: ["文献 A｜<source> 失败 & 重试"] }
    );
    assert.equal(windows[0].descriptions.length, 1);
    assert.match(windows[0].descriptions[0], /&lt;source&gt;/);
    assert.match(windows[0].descriptions[0], /&amp;/);
    assert.deepEqual(windows[0].events, ["show"]);
});

test("主流程先显示窗口，文献处理期间持续更新完成数", async () => {
    const { context, windows } = fixture();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    context.pending = pending;
    context.scopes = [
        { literature: { getField: () => "正文与 SI", key: "KEY1" }, all: true },
        { literature: { getField: () => "DOCX", key: "KEY2" }, all: true },
    ];
    vm.runInContext(`
        resolveScopes = async () => scopes;
        consumeScope = async (_scope, _warnings) => {
            await pending;
            return { updated: 2 };
        };
    `, context);
    const task = vm.runInContext(script.slice(script.indexOf(marker)), context);
    assert.equal(windows.length, 1);
    assert.deepEqual(windows[0].events, ["show"]);
    await Promise.resolve();
    await Promise.resolve();
    release();
    await task;
    assert.equal(windows.length, 1);
    assert.match(windows[0].headlines.at(-1), /同步附件/);
    assert.deepEqual(windows[0].events, ["show", "timer:5000"]);
});

test("准备阶段异常复用已显示的进度窗口，不新增报错窗口", async () => {
    const { context, windows } = fixture();
    vm.runInContext('resolveScopes = async () => { throw new Error("读取选择范围失败"); };', context);
    const task = vm.runInContext(script.slice(script.indexOf(marker)), context);
    assert.equal(windows.length, 1);
    await task;
    assert.equal(windows.length, 1);
    assert.match(windows[0].headlines.at(-1), /失败/);
    assert.match(windows[0].descriptions[0], /读取选择范围失败/);
    assert.deepEqual(windows[0].events, ["show"]);
});
