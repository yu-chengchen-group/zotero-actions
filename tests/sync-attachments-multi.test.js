const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../scripts/sync-attachments.js"), "utf8");
const start = script.indexOf("\n(async () => {");
const A = "A7YB92CX";
const B = "B8ZC23DA";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function makeSource(key, name, hash) {
    return {
        key, path: name, sourceHash: hash,
        attachmentFilename: name, attachmentContentType: "application/pdf",
        isAttachment: () => true,
        getFilePathAsync: async () => name,
        getField: () => "PDF",
        addTag: () => { throw new Error("不允许新增身份 Tag"); },
    };
}

function fixture(teacher) {
    const events = { uploads: [], commits: [], downloads: [], bundles: [], windows: [] };
    class Window {
        constructor() {
            this.ItemProgress = class {
                setProgress(n) { this.progress = n; }
                setText(t) { this.text = t; }
            };
            this.description = [];
            events.windows.push(this);
        }
        changeHeadline(t) { this.headline = t; }
        addDescription(t) { this.description.push(t); }
        show() {}
        startCloseTimer() {}
    }
    const literature = {
        id: 3, key: "PARENT01", libraryID: 1,
        deleted: false, isRegularItem: () => true,
        getField: field => ({
            DOI: "10.1000/test", title: "Paper",
            citationKey: "paper",
        })[field] || "",
        getAttachments: () => [],
    };
    const ctx = vm.createContext({
        items: [literature], literature, events,
        Services: { env: { get: key =>
            key === (teacher ? "CHEN_GROUP_API_KEY" : "CHEN_GROUP_API_KEY_MEMBER") ? "test" : "" } },
        Zotero: {
            ProgressWindow: Window,
            Libraries: { userLibraryID: 1 },
            Attachments: { LINK_MODE_LINKED_URL: 3 },
            Items: { getAsync: async () => null },
            logError: err => { events.error = err; },
        },
        IOUtils: { exists: async () => true },
    });
    vm.runInContext(script.slice(0, start), ctx);
    return { ctx, events };
}

function inject(ctx, statements) {
    vm.runInContext(statements.join("\n"), ctx);
}

async function run(ctx) {
    await vm.runInContext(script.slice(start), ctx);
}

test("教师发布正文和 SI，清单只提交一次，不生成身份 Tag", async () => {
    const { ctx, events } = fixture(true);
    ctx.files = [makeSource(A, "paper.pdf", SHA_A), makeSource(B, "SI.pdf", SHA_B)];
    inject(ctx, [
        "sourceAttachments = async () => files;",
        "localPdf = async () => null;",
        "localMarkdown = async () => null;",
        "getRemoteState = async () => ({attachments: [], pdf: {status:'missing'}});",
        "sha256File = name => files.find(f => f.path === name).sourceHash;",
        "matchingMarkdown = async () => ({path:'existing.md'});",
        "matchesSource = async () => true;",
        "markdownMatchesPdf = async () => true;",
        "createBundle = async (md,id,hash) => ({directory:null,path:id+'.zip'});",
        "uploadFile = async (ident,kind,path,mime,id) => {events.uploads.push([kind,id]);return {sha256:'f'.repeat(64)}};",
        "publishManifest = async (ident,records) => events.commits.push(records);",
    ]);
    await run(ctx);
    assert.equal(events.error, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(events.uploads)), [
        ["source", A], ["bundle", A],
        ["source", B], ["bundle", B],
    ]);
    assert.equal(events.commits.length, 1);
    assert.deepEqual(Array.from(events.commits[0], r => r.filename), ["paper.pdf", "SI.pdf"]);
    assert.equal(events.windows.length, 1);
});

test("学生从纯元数据下载全部附件和 MD，重复同步不新增文件", async () => {
    const { ctx, events } = fixture(false);
    ctx.files = [makeSource(A, "paper.pdf", SHA_A), makeSource(B, "SI.pdf", SHA_B)];
    ctx.current = [];
    inject(ctx, [
        "localPdf = async () => null;",
        "localMarkdown = async () => null;",
        "getRemoteState = async () => ({pdf:{status:'missing'},attachments:files.map(f=>({id:f.key,filename:f.attachmentFilename,content_type:'application/pdf',sha256:f.sourceHash,bundle_sha256:'f'.repeat(64)}))});",
        "sourceAttachments = async () => current;",
        "findLocalSource = async (lit,rec) => current.find(f=>f.attachmentFilename===rec.filename)||null;",
        "downloadSource = async (lit,ident,rec) => {events.downloads.push(rec.id);let f=files.find(f=>f.key===rec.id);current.push(f);return f};",
        "sha256File = name => files.find(f=>f.path===name).sourceHash;",
        "matchingMarkdown = async (lit,f) => events.bundles.includes(f.key) ? {path:'cached.md'} : null;",
        "matchesSource = async () => true;",
        "installBundle = async (lit,ident,rec) => events.bundles.push(rec.id);",
    ]);
    await run(ctx);
    await run(ctx);
    assert.deepEqual(events.downloads, [A, B]);
    assert.deepEqual(events.bundles, [A, B]);
    assert.equal(events.error, undefined);
});

test("教师附件与云端 SHA 相同时不重复上传", async () => {
    const { ctx, events } = fixture(true);
    ctx.files = [makeSource(A, "paper.pdf", SHA_A)];
    inject(ctx, [
        "sourceAttachments = async () => files;",
        "localPdf = async () => null;",
        "localMarkdown = async () => null;",
        "getRemoteState = async () => ({pdf:{status:'missing'},attachments:[{id:files[0].key,filename:files[0].attachmentFilename,content_type:'application/pdf',sha256:files[0].sourceHash,bundle_sha256:'f'.repeat(64)}]});",
        "sha256File = () => files[0].sourceHash;",
        "matchingMarkdown = async () => ({path:'existing.md'});",
        "matchesSource = async () => true;",
        "uploadFile = async () => { throw new Error('不应重复上传') };",
        "publishManifest = async () => { throw new Error('不应重复提交') };",
    ]);
    await run(ctx);
    assert.equal(events.error, undefined);
    assert.equal(events.uploads.length, 0);
    assert.equal(events.commits.length, 0);
});

test("同名哈希冲突只报告错误，不覆盖文件", async () => {
    const { ctx, events } = fixture(false);
    ctx.files = [makeSource(A, "paper.pdf", SHA_A)];
    ctx.localFile = makeSource(B, "paper.pdf", SHA_B);
    inject(ctx, [
        "localPdf = async () => null;",
        "localMarkdown = async () => null;",
        "getRemoteState = async () => ({pdf:{status:'missing'},attachments:files.map(f=>({id:f.key,filename:f.attachmentFilename,content_type:'application/pdf',sha256:f.sourceHash,bundle_sha256:null}))});",
        "findLocalSource = async () => localFile;",
        "sha256File = () => localFile.sourceHash;",
        "downloadSource = async () => {throw new Error('不应覆盖文件')};",
    ]);
    await run(ctx);
    assert.equal(ctx.localFile.sourceHash, SHA_B);
    assert.equal(events.windows.length, 1);
    assert.match(events.windows[0].description.join(" "), /保留本地附件/);
});

test("不修改旧版进度窗口四个函数，也不引入 chen 身份标签", () => {
    const legacy = fs.readFileSync(
        path.join(__dirname, "../scripts/sync-attachments.js"), "utf8"
    );
    assert.match(legacy, /function updateCheckProgress\(batch, checked, total, activeChecks\)/);
    assert.match(legacy, /function createBatchProgress\(total\)/);
    assert.match(legacy, /function updateBatchProgress\(batch, processed, total/);
    assert.match(legacy, /function showFinalSummary\(batch, summary\)/);
    assert.doesNotMatch(legacy, /@chen-source|@chen-md|@chen-bundle/);
});

test("学生无 DOI 且没有共享 Cache-Key 时拒绝自行生成", async () => {
    const { ctx } = fixture(false);
    ctx.noDoi = { getField: () => "" };
    await assert.rejects(
        vm.runInContext("attachmentIdentity(noDoi)", ctx),
        /学生不能自行生成/
    );
});

test("进度标题固定、圆形进度保留、状态文字不重复", () => {
    for (const teacher of [true, false]) {
        const { ctx, events } = fixture(teacher);
        const batch = vm.runInContext("createBatchProgress(10)", ctx);
        ctx.batch = batch;
        assert.equal(events.windows[0].headline, teacher ? "发布附件" : "同步附件");

        vm.runInContext("updateCheckProgress(batch, 3, 10, 8)", ctx);
        assert.equal(batch.statusLine.progress, 15);
        assert.equal(batch.statusLine.text, "检查 3/10 · 8 项处理中");

        vm.runInContext("updateBatchProgress(batch, 4, 10)", ctx);
        assert.equal(batch.statusLine.progress, 70);
        assert.equal(batch.statusLine.text, teacher ? "发布 4/10" : "同步 4/10");

        vm.runInContext('updateBatchProgress(batch, 4, 10, "转换", "paper.pdf")', ctx);
        assert.equal(batch.statusLine.progress, 70);
        assert.equal(batch.statusLine.text, "转换：paper.pdf");
        assert.equal(batch.titleLine.text, "");
        assert.equal(events.windows[0].headline, teacher ? "发布附件" : "同步附件");
    }
});

test("同步到群组前仅对无 DOI 文献生成一次共享 Cache-Key", async () => {
    const source = fs.readFileSync(
        path.join(__dirname, "../scripts/sync-to-group.js"), "utf8"
    );
    const ctx = vm.createContext({
        Services: {
            uuid: { generateUUID: () => ({
                toString: () => "{550e8400-e29b-41d4-a716-446655440000}",
            }) },
        },
    });
    vm.runInContext(source.slice(0, source.indexOf("\n(async () => {")), ctx);
    let extra = "Archive: arXiv";
    let writes = 0;
    ctx.parent = {
        getField: field => field === "extra" ? extra : "",
        setField: (_field, value) => { extra = value; },
        saveTx: async () => { writes++; },
    };
    await vm.runInContext("ensureSharedCacheKey(parent)", ctx);
    await vm.runInContext("ensureSharedCacheKey(parent)", ctx);
    assert.match(extra, /Cache-Key: chen:550e8400-e29b-41d4-a716-446655440000/);
    assert.equal(writes, 1);
});
