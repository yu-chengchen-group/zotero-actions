const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../scripts/sync-attachments.js"), "utf8");
const A = "A7YB92CX";
const B = "B8ZC23DA";
const digest = "a".repeat(64);

function fixture(teacher = true) {
    const state = { sources: [], uploads: [], commits: [], remote: [] };
    const context = vm.createContext({
        Services: {
            env: { get: key => key === (teacher ? "CHEN_GROUP_API_KEY" : "CHEN_GROUP_API_KEY_MEMBER")
                ? "token" : "" },
        },
        Zotero: { Attachments: { LINK_MODE_LINKED_URL: 3 } },
        IOUtils: { stat: async () => ({ size: 20 }) },
        state,
    });
    vm.runInContext(script.slice(0, script.indexOf("\n(async () => {")), context);
    vm.runInContext(`
        remoteState = async () => ({ attachments: state.remote, discovery: { status: "missing" } });
        maybeDiscover = async (literature, identity, sources) => sources;
        sourceItems = () => state.sources;
        sourceInfo = async source => ({
            attachment: source, id: source.cloudID, filename: source.filename,
            path: source.path, sha256: source.sha256, content_type: "application/pdf",
        });
        setManagedTag = async () => {};
        convertSupported = () => false;
        upload = async (identity, kind, id, filename) => {
            state.uploads.push({ kind, id });
            return { sha256: "b".repeat(64) };
        };
        publishManifest = async (identity, attachments) => {
            state.commits.push({ identity, attachments });
        };
    `, context);
    const literature = {
        getField: field => field === "DOI" ? "10.1000/test" : "",
    };
    return { state, context, literature };
}

function source(id, filename) {
    return {
        id, cloudID: id, filename, path: "/storage/" + filename, sha256: digest,
        getTags: () => [], getAnnotations: () => [], attachmentLinkMode: 0,
    };
}

test("教师一次发布正文及 SI，且只提交一份完整清单", async () => {
    const { context, state, literature } = fixture();
    state.sources = [source(A, "paper.pdf"), source(B, "paper_SI.pdf")];
    const publish = vm.runInContext("publishScope", context);
    const result = await publish({ literature, all: true, selected: new Set() }, []);
    assert.equal(result.updated, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(state.uploads)), [
        { kind: "source", id: A }, { kind: "source", id: B },
    ]);
    assert.equal(state.commits.length, 1);
    assert.deepEqual(
        Array.from(state.commits[0].attachments, x => x.filename),
        ["paper.pdf", "paper_SI.pdf"]
    );
});

test("单选 SI 发布只更新 SI，不删除原正文", async () => {
    const { context, state, literature } = fixture();
    state.sources = [source(B, "SI.pdf")];
    state.remote = [{
        id: A, filename: "paper.pdf", content_type: "application/pdf",
        sha256: "e".repeat(64), size: 20, bundle_sha256: "f".repeat(64),
    }];
    await vm.runInContext("publishScope", context)(
        { literature, all: false, selected: new Set([2]) }, []
    );
    assert.deepEqual(Array.from(state.commits[0].attachments, x => x.id), [A, B]);
});

test("教师本地附件被删除时，不清理服务器已有附件", async () => {
    const { context, state, literature } = fixture();
    state.remote = [{ id: A, filename: "paper.pdf", sha256: digest }];
    const warnings = [];
    const result = await vm.runInContext("publishScope", context)(
        { literature, all: true, selected: new Set() }, warnings
    );
    assert.equal(result.updated, 0);
    assert.equal(state.commits.length, 0);
    assert.match(warnings[0], /保持不变/);
});

test("发布失败不会提交新的 manifest", async () => {
    const { context, state, literature } = fixture();
    state.sources = [source(A, "paper.pdf"), source(B, "SI.pdf")];
    vm.runInContext(`
        upload = async (identity, kind, id) => {
            if (id === "B8ZC23DA") throw new Error("network failure");
        };
    `, context);
    await assert.rejects(
        vm.runInContext("publishScope", context)(
            { literature, all: true, selected: new Set() }, []
        ),
        /network failure/
    );
    assert.equal(state.commits.length, 0);
});

test("云端附件源哈希变化时，本地有修改必须保留原件", async () => {
    const { context, state, literature } = fixture(false);
    const local = source(A, "paper.pdf");
    local.sha256 = "c".repeat(64);
    state.sources = [local];
    state.remote = [{
        id: A, filename: "paper.pdf", content_type: "application/pdf",
        sha256: digest, size: 20, bundle_sha256: null,
    }];
    vm.runInContext(`
        localMatch = async () => state.sources[0];
        matchingMD = () => null;
        convertSupported = () => false;
    `, context);
    const warnings = [];
    const result = await vm.runInContext("consumeScope", context)(
        { literature, all: true, selected: new Set() }, warnings
    );
    assert.equal(result.updated, 0);
    assert.match(warnings[0], /保留原文件/);
    assert.equal(state.sources[0], local);
});

test("本地与上次同步哈希一致时可安全自动更新云端新版", async () => {
    const { context, state, literature } = fixture(false);
    const local = source(A, "paper.pdf");
    const previous = "c".repeat(64);
    local.sha256 = previous;
    state.sources = [local];
    state.remote = [{
        id: A, filename: "paper.pdf", content_type: "application/pdf",
        sha256: digest, size: 20, bundle_sha256: null,
    }];
    vm.runInContext(`
        localMatch = async () => state.sources[0];
        matchingMD = () => null;
        convertSupported = () => false;
        trackedHash = () => "c".repeat(64);
        download = async () => new Uint8Array([1, 2, 3]);
        replaceUnmodifiedSource = async (attachment, record) => {
            attachment.sha256 = record.sha256;
        };
    `, context);
    const warnings = [];
    const result = await vm.runInContext("consumeScope", context)(
        { literature, all: true, selected: new Set() }, warnings
    );
    assert.equal(result.updated, 1);
    assert.equal(local.sha256, digest);
    assert.equal(warnings.length, 0);
});
