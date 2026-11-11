const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(
    path.join(__dirname, "../scripts/sync-attachments.js"), "utf8"
);

function makeItem(filename, id, { linkedURL = false, type = "attachment" } = {}) {
    const tags = [];
    return {
        id, key: `A${String(id).padStart(7, "0")}`, attachmentFilename: filename,
        deleted: false, attachmentLinkMode: linkedURL ? 3 : 0,
        isAttachment: () => type === "attachment",
        isRegularItem: () => type === "regular",
        getField: field => field === "title" ? filename : "",
        getTags: () => tags.map(tag => ({ tag })),
        addTag: value => tags.push(value),
        removeTag: value => tags.splice(tags.indexOf(value), 1),
        saveTx: async () => {},
        getFilePathAsync: async () => `/storage/${filename}`,
    };
}

function fixture(teacher = false) {
    const elements = new Map();
    const context = vm.createContext({
        Services: {
            env: { get: name => name === (teacher ? "CHEN_GROUP_API_KEY" : "CHEN_GROUP_API_KEY_MEMBER")
                ? "test" : "" },
            uuid: { generateUUID: () => ({ toString: () => "{550e8400-e29b-41d4-a716-446655440000}" }) },
        },
        Zotero: {
            Attachments: { LINK_MODE_LINKED_URL: 3 },
            Libraries: { userLibraryID: 1 },
            Items: { get: id => elements.get(id) },
        },
    });
    vm.runInContext(script.slice(0, script.indexOf("\n(async () => {")), context);
    return { context, elements, item: makeItem };
}

test("正文、SI、DOCX 和任意非 MD 文件均属于源附件", () => {
    const { context, elements, item } = fixture();
    const entries = [
        item("paper.pdf", 1), item("paper_SI.pdf", 2), item("table.xlsx", 3),
        item("archive.zip", 4), item("paper.pdf.md", 5),
        item("d2md_fig_001.png", 6), item("web.pdf", 7, { linkedURL: true }),
        item("Zotero Note", 8, { type: "note" }),
    ];
    entries.forEach(entry => elements.set(entry.id, entry));
    const selected = vm.runInContext(
        "sourceItems", context
    )({ getAttachments: () => entries.map(entry => entry.id) });
    assert.deepEqual(selected.map(value => value.id), [4, 2, 1, 3]);
});

test("群组复制后的学生个人文库没有附件 Key 也能凭 DOI 查找", async () => {
    const { context } = fixture();
    const identity = vm.runInContext("literatureIdentity", context);
    const result = await identity({ getField: key => key === "DOI" ? "10.1000/Test" : "" });
    assert.equal(result.type, "doi");
    assert.equal(result.value, "10.1000/test");
});

test("无 DOI 时学生拒绝自行生成 Cache-Key", async () => {
    const { context } = fixture();
    const identity = vm.runInContext("literatureIdentity", context);
    await assert.rejects(
        identity({ getField: () => "" }),
        /不能自行生成共享标识/
    );
});

test("教师无 DOI 时只生成一次持久 Cache-Key", async () => {
    const { context } = fixture(true);
    const identity = vm.runInContext("literatureIdentity", context);
    let extra = "Original: data";
    let saves = 0;
    const literature = {
        getField: key => key === "extra" ? extra : "",
        setField: (key, value) => { assert.equal(key, "extra"); extra = value; },
        saveTx: async () => { saves++; },
    };
    const first = await identity(literature);
    const second = await identity(literature);
    assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
    assert.equal(saves, 1);
    assert.match(extra, /Cache-Key: chen:550e8400-e29b-41d4-a716-446655440000/);
});

test("源附件和 MD 使用独立的云端标签，不依赖学生本地 Zotero Key", async () => {
    const { context, item } = fixture();
    const source = item("SI.pdf", 123);
    const tag = vm.runInContext("setManagedTag", context);
    await tag(source, "@chen-source:", "Z9FA3K6W");
    assert.equal(vm.runInContext("tagID", context)(source, "@chen-source:"), "Z9FA3K6W");
    assert.notEqual(source.key, "Z9FA3K6W");
    await tag(source, "@chen-source:", "Y8FB4J7V");
    assert.deepEqual(source.getTags().map(tag => tag.tag), ["@chen-source:Y8FB4J7V"]);
});
