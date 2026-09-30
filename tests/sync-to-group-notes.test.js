const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(
    path.join(__dirname, "../scripts/sync-to-group.js"), "utf8"
);
const CLASSIFICATION = "<p><strong>Classification Record</strong></p><pre>{}</pre>";
const citations = name => `<h1>${name}</h1>\n<p>Do not edit this note manually!</p><pre>[]</pre>`;


function fixture() {
    let nextID = 100;
    const byID = new Map();
    const erased = [];
    const source = { getNotes: () => sourceIDs };
    const target = { id: 99, getNotes: () => targetIDs };
    const sourceIDs = [];
    const targetIDs = [];

    function add(html, { group = false, version = 1, linked = null } = {}) {
        const note = {
            id: ++nextID,
            key: `NOTE${nextID}`,
            version,
            parentID: group ? target.id : 1,
            deleted: false,
            html,
            linked,
            getNote() { return this.html; },
            getTags() { return [{ tag: "test" }]; },
            setNote(value) { this.html = value; },
            setTags(value) { this.tags = value; },
            async getLinkedItem() { return this.linked; },
            async addLinkedItem(value) { this.linked = value; },
            clone() {
                return add(this.html, { group: true });
            },
            async save() {
                byID.set(this.id, this);
            },
        };
        byID.set(note.id, note);
        (group ? targetIDs : sourceIDs).push(note.id);
        return note;
    }

    const Zotero = {
        Items: {
            getAsync: async id => byID.get(id),
            erase: async ids => {
                erased.push(...ids);
                for (const id of ids) {
                    byID.get(id).deleted = true;
                }
            },
        },
        DB: { executeTransaction: async fn => fn() },
    };
    const context = vm.createContext({ item: {}, Zotero });
    vm.runInContext(script, context);
    return {
        add, erased, source, target,
        mirrorNotes: vm.runInContext("mirrorNotes", context),
        liveGroup: () => targetIDs.map(id => byID.get(id)).filter(note => !note.deleted),
    };
}


test("只同步机器 Note，保留人工 Note，分段 Citations 独立同步", async () => {
    const f = fixture();
    const sourceRecord = f.add(CLASSIFICATION);
    const existingRecord = f.add(CLASSIFICATION, { group: true });
    sourceRecord.linked = existingRecord;
    f.add(citations("Citations000"));
    f.add(citations("Citations001"));
    f.add("<p>个人手写 Note</p>");
    const groupManual = f.add("<p>群组人工 Note</p>", { group: true });
    const stale = f.add(citations("Citations002"), { group: true });

    await f.mirrorNotes(f.source, f.target, { libraryID: 2 });
    assert.equal(sourceRecord.linked.id, existingRecord.id);
    assert.deepEqual(f.erased, [stale.id]);
    assert.equal(f.liveGroup().some(note => note.id === groupManual.id), true);
    assert.equal(f.liveGroup().filter(note => note.getNote().startsWith("<h1>Citations")).length, 2);
    assert.equal(f.liveGroup().length, 4);
});


test("同类重复保留最新版，缺失源 Note 时只删除机器 Note", async () => {
    const f = fixture();
    f.add(CLASSIFICATION, { version: 1 });
    const newestSource = f.add(CLASSIFICATION, { version: 3 });
    const oldTarget = f.add(CLASSIFICATION, { group: true, version: 2 });
    const newTarget = f.add(CLASSIFICATION, { group: true, version: 4 });
    const manual = f.add("<p>人工 Note</p>", { group: true });

    await f.mirrorNotes(f.source, f.target, { libraryID: 2 });
    assert.equal(newestSource.linked.id, newTarget.id);
    assert.deepEqual(f.erased, [oldTarget.id]);
    assert.equal(f.liveGroup().some(note => note.id === manual.id), true);

    f.source.getNotes().length = 0;
    await f.mirrorNotes(f.source, f.target, { libraryID: 2 });
    assert.deepEqual(f.erased, [oldTarget.id, newTarget.id]);
    assert.deepEqual(f.liveGroup().map(note => note.id), [manual.id]);
});


test("错误的 linked Note 关系会拒绝覆盖，也不触发删除", async () => {
    const f = fixture();
    const source = f.add(CLASSIFICATION);
    const manual = f.add("<p>群组人工 Note</p>", { group: true });
    source.linked = manual;
    await assert.rejects(
        f.mirrorNotes(f.source, f.target, { libraryID: 2 }),
        /受管理 Note 关联异常/
    );
    assert.equal(manual.getNote(), "<p>群组人工 Note</p>");
    assert.deepEqual(f.erased, []);
});


test("人工写有 Citations 标题但无机器声明时不属于受管理 Note", async () => {
    const f = fixture();
    const manual = f.add("<h1>Citations</h1><p>个人编辑</p>", { group: true });
    await f.mirrorNotes(f.source, f.target, { libraryID: 2 });
    assert.equal(f.liveGroup().length, 1);
    assert.equal(f.liveGroup()[0].id, manual.id);
    assert.deepEqual(f.erased, []);
});
