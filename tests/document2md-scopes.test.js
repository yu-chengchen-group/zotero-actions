const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../scripts/document2md.js"), "utf8");

function fixture() {
    const entries = new Map();
    const parent = {
        id: 1, key: "PARENT01", libraryID: 1, deleted: false,
        isRegularItem: () => true, getAttachments: () => [...entries.keys()],
        getField: () => "Paper",
    };
    function source(id, name) {
        return {
            id, key: "SOURCE" + String(id).padStart(2, "0"), parentID: 1, deleted: false,
            attachmentFilename: name, attachmentLinkMode: 0,
            isAttachment: () => true, isRegularItem: () => false,
            getFilePath: () => "/tmp/" + name,
            getField: () => name,
            getTags: () => [],
        };
    }
    const context = vm.createContext({
        Services: { env: { get: () => "member-token" } },
        Zotero: {
            Attachments: { LINK_MODE_LINKED_URL: 3 },
            Items: { get: id => id === 1 ? parent : entries.get(id) },
            Libraries: { userLibraryID: 1 },
        },
    });
    vm.runInContext(script.slice(0, script.indexOf("\nawait (async () => {")), context);
    return { context, entries, parent, source };
}

test("只选择 SI 时作用范围只有 SI", () => {
    const { context, entries, source } = fixture();
    const pdf = source(2, "paper.pdf");
    const si = source(3, "SI.pdf");
    entries.set(2, pdf); entries.set(3, si);
    const scopes = vm.runInContext("buildScopes", context)([si]);
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0].allSources, false);
    assert.deepEqual(Array.from(scopes[0].sources, entry => entry.attachment.id), [3]);
});

test("选择文献时正文和 SI 都进入转换范围", () => {
    const { context, entries, parent, source } = fixture();
    entries.set(2, source(2, "paper.pdf"));
    entries.set(3, source(3, "SI.pdf"));
    const scopes = vm.runInContext("buildScopes", context)([parent]);
    assert.deepEqual(
        Array.from(scopes[0].sources, entry => entry.attachment.id).sort(),
        [2, 3]
    );
});

test("Markdown、Zotero 笔记和生成图片不作为源文件", () => {
    const { context, entries, parent, source } = fixture();
    entries.set(2, source(2, "SI.pdf"));
    entries.set(3, source(3, "SI.pdf.md"));
    entries.set(4, source(4, "d2md_fig_001.png"));
    entries.set(5, { id: 5, deleted: false, isAttachment: () => false });
    assert.deepEqual(
        Array.from(vm.runInContext("getSourceAttachments", context)(parent), entry => entry.attachment.id),
        [2]
    );
});

test("同名源文件的输出 MD 名称使用不同附件标识", () => {
    const { context, entries, parent, source } = fixture();
    entries.set(2, source(2, "SI.pdf"));
    entries.set(3, source(3, "SI.pdf"));
    const sources = vm.runInContext("getSourceAttachments", context)(parent);
    const name = vm.runInContext("markdownName", context);
    assert.notEqual(name(parent, sources[0]), name(parent, sources[1]));
    assert.match(name(parent, sources[0]), /^SI\.pdf\.SOURCE\d+\.md$/);
});
