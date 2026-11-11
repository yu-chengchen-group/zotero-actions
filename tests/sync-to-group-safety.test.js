const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(
    path.join(__dirname, "../scripts/sync-to-group.js"),
    "utf8"
);


test("构建群组索引前先加载 itemData", async () => {
    let loaded = false;
    const target = {
        id: 1,
        deleted: false,
        isRegularItem: () => true,
        getField(field) {
            assert.equal(field, "citationKey");
            assert.equal(loaded, true);
            return "target-key";
        },
    };
    const Zotero = {
        Items: {
            getAll: async () => [target],
            loadDataTypes: async items => {
                assert.deepEqual(items, [target]);
                loaded = true;
            },
        },
    };
    const context = vm.createContext({ item: {}, Zotero });
    vm.runInContext(script, context);
    const buildTargetIndex = vm.runInContext("buildTargetIndex", context);

    const index = await buildTargetIndex(2);
    assert.equal(index.get("target-key"), target);
});


test("单篇同步失败时不移除 Collection 原有成员", async () => {
    const removed = [];
    const sourceItem = {
        id: 11,
        key: "SOURCE01",
        libraryID: 1,
        deleted: false,
        isRegularItem: () => true,
        getField(field) {
            if (field === "citationKey") return "duplicate-key";
            if (field === "title") return "失败样本文献";
            return "";
        },
    };
    const currentTargetItem = {
        id: 91,
        deleted: false,
        isRegularItem: () => true,
    };
    const targetCollection = {
        id: 31,
        name: "测试分类",
        parentID: false,
        deleted: false,
        getChildItems: () => [currentTargetItem],
        addItems: async () => {},
        removeItems: async ids => removed.push(...ids),
    };
    const sourceCollection = {
        id: 21,
        name: "测试分类",
        parentID: false,
        async getLinkedCollection() {
            return targetCollection;
        },
        async addLinkedCollection() {},
        getChildItems: () => [sourceItem],
    };
    const Zotero = {
        Libraries: { userLibraryID: 1 },
        Collections: {
            getByParent(id) {
                if (id === sourceCollection.id || id === targetCollection.id) {
                    return [];
                }
                return [];
            },
            erase: async () => {},
        },
        DB: { executeTransaction: async fn => fn() },
        Items: {
            loadDataTypes: async () => {},
        },
        logError: () => {},
    };
    const context = vm.createContext({ item: {}, Zotero });
    vm.runInContext(script, context);
    const syncCollection = vm.runInContext("syncCollection", context);
    const syncContext = {
        libraryID: 2,
        targetIndex: new Map([["duplicate-key", null]]),
        summary: {
            created: 0,
            itemsRemoved: 0,
            collectionsCreated: 0,
            collectionsRemoved: 0,
            failed: [],
        },
        batch: {
            itemIDs: new Set(),
            collectionIDs: new Set(),
            progress: { changeHeadline: () => {} },
            statusLine: { setText: () => {} },
            titleLine: { setText: () => {} },
        },
    };

    await syncCollection(sourceCollection, null, syncContext);
    assert.equal(syncContext.summary.failed.length, 1);
    assert.deepEqual(removed, []);
});


test("同步个人条目前先加载 itemData", async () => {
    let loaded = false;
    const source = {
        id: 17,
        key: "SOURCE17",
        libraryID: 1,
        deleted: false,
        isRegularItem: () => true,
        getField(field) {
            if (field === "title") return "懒加载样本文献";
            if (field === "DOI") return "10.1000/test";
            if (field === "citationKey") {
                assert.equal(loaded, true);
                return "lazy-source-key";
            }
            return "";
        },
        clone() {
            return {
                toJSON: () => ({}),
            };
        },
        getTags: () => [],
        getNotes: () => [],
        async addLinkedItem() {},
    };
    const target = {
        id: 27,
        deleted: false,
        fromJSON() {},
        setField() {},
        setTags() {},
        async save() {},
        getNotes: () => [],
    };
    const Zotero = {
        Libraries: { userLibraryID: 1 },
        DB: { executeTransaction: async fn => fn() },
        Items: {
            getAsync: async () => null,
            erase: async () => {},
            loadDataTypes: async items => {
                assert.equal(items.length, 1);
                assert.equal(items[0], source);
                loaded = true;
            },
        },
    };
    const context = vm.createContext({ item: {}, Zotero });
    vm.runInContext(script, context);
    const mirrorItem = vm.runInContext("mirrorItem", context);
    const syncContext = {
        libraryID: 2,
        targetIndex: new Map([["lazy-source-key", target]]),
        summary: { created: 0 },
        batch: {
            itemIDs: new Set(),
            collectionIDs: new Set(),
            progress: { changeHeadline: () => {} },
            statusLine: { setText: () => {} },
            titleLine: { setText: () => {} },
        },
    };

    await mirrorItem(source, syncContext);
    assert.equal(loaded, true);
});
