import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    GLOBAL_FIELDS,
    SHARE_FIELDS,
    effectiveShareBoolean,
    effectiveShareValue,
    isFieldParameter,
    isPrintingEnabled,
    isShareEnabled,
    joinList,
    listShareNames,
    setPrintingEnabled,
    setShareEnabled,
    splitList,
} from "../../src/model.ts";
import { parseConfiguration, serializeConfiguration } from "../../src/smb-conf.ts";
import {
    validateDocument,
    validateFieldValue,
    validateNewUserName,
    validateParameterName,
    validateParameterValue,
    validatePassword,
    validateShareName,
} from "../../src/validation.ts";

const field = (fields: typeof SHARE_FIELDS, parameter: string) => fields.find(candidate => candidate.parameter === parameter)!;

describe("model", () => {
    const document = parseConfiguration(`[global]
   guest ok = yes
   create mask = 0700
[Data]
   path = /srv/data
   writeable = yes
[homes]
[old]
   path = /srv/old
   available = no
`);

    test("share names exclude global", () => {
        assert.deepEqual(listShareNames(document), ["Data", "homes", "old"]);
    });

    test("effective values fall back to [global], then the default; synonyms count", () => {
        assert.equal(effectiveShareValue(document, "data", "create mask", "0744"), "0700");
        assert.equal(effectiveShareValue(document, "data", "directory mask", "0755"), "0755");
        assert.equal(effectiveShareBoolean(document, "Data", "read only", true), false);
        assert.equal(effectiveShareBoolean(document, "homes", "read only", true), true);
        assert.equal(effectiveShareBoolean(document, "homes", "guest ok", false), true);
    });

    test("enable and disable a share with available", () => {
        assert.equal(isShareEnabled(document, "old"), false);
        assert.equal(isShareEnabled(document, "Data"), true);
        const enabled = setShareEnabled(document, "old", true);
        assert.equal(isShareEnabled(enabled, "old"), true);
        assert.ok(!serializeConfiguration(enabled).includes("available"));
        assert.equal(isShareEnabled(setShareEnabled(document, "Data", false), "Data"), false);
    });

    test("printing switch writes and removes the usual parameters", () => {
        assert.equal(isPrintingEnabled(document), true);
        const off = setPrintingEnabled(document, false);
        assert.equal(isPrintingEnabled(off), false);
        assert.match(serializeConfiguration(off), /printcap name = \/dev\/null/);
        assert.equal(serializeConfiguration(setPrintingEnabled(off, true)), serializeConfiguration(document));
    });

    test("field parameters match synonyms", () => {
        assert.ok(isFieldParameter(SHARE_FIELDS, "writable"));
        assert.ok(isFieldParameter(SHARE_FIELDS, "Browsable"));
        assert.ok(isFieldParameter(GLOBAL_FIELDS, "min protocol"));
        assert.ok(!isFieldParameter(SHARE_FIELDS, "veto files"));
    });

    test("user lists split on spaces and commas; quoted names stay whole", () => {
        assert.deepEqual(splitList(`alice, @staff "Domain Users" bob`), ["alice", "@staff", "Domain Users", "bob"]);
        assert.equal(joinList(["alice", "@staff", "Domain Users"]), `alice @staff "Domain Users"`);
    });
});

describe("validation", () => {
    test("share names", () => {
        assert.equal(validateShareName("scans"), null);
        assert.equal(validateShareName("print$"), null);
        assert.notEqual(validateShareName(""), null);
        assert.notEqual(validateShareName("a]b"), null);
        assert.notEqual(validateShareName("GLOBAL"), null);
        assert.notEqual(validateShareName("Data", ["data"]), null);
    });

    test("parameter names and values", () => {
        assert.equal(validateParameterName("recycle:repository"), null);
        assert.equal(validateParameterName("veto files"), null);
        assert.notEqual(validateParameterName("[x]"), null);
        assert.notEqual(validateParameterName(""), null);
        assert.equal(validateParameterValue("/%U/x"), null);
        assert.notEqual(validateParameterValue("a\nb = c"), null);
        assert.notEqual(validateParameterValue("ends with \\"), null);
    });

    test("field kinds", () => {
        assert.equal(validateFieldValue(field(SHARE_FIELDS, "create mask"), "0660"), null);
        assert.notEqual(validateFieldValue(field(SHARE_FIELDS, "create mask"), "rw"), null);
        assert.equal(validateFieldValue(field(SHARE_FIELDS, "browseable"), "No"), null);
        assert.notEqual(validateFieldValue(field(SHARE_FIELDS, "browseable"), "maybe"), null);
        assert.equal(validateFieldValue(field(SHARE_FIELDS, "valid users"), "alice @staff +office"), null);
        assert.notEqual(validateFieldValue(field(SHARE_FIELDS, "valid users"), "@"), null);
        assert.equal(validateFieldValue(field(SHARE_FIELDS, "hosts allow"), "192.168.1.50 10.0.0.0/8 EXCEPT 10.0.0.1"), null);
        assert.notEqual(validateFieldValue(field(SHARE_FIELDS, "hosts allow"), "a;b"), null);
        assert.equal(validateFieldValue(field(SHARE_FIELDS, "path"), "/srv/scans"), null);
        assert.notEqual(validateFieldValue(field(SHARE_FIELDS, "path"), "srv"), null);
        assert.notEqual(validateFieldValue(field(SHARE_FIELDS, "path"), "/srv/../etc"), null);
        assert.equal(validateFieldValue(field(GLOBAL_FIELDS, "server min protocol"), "NT1"), null);
        assert.equal(validateFieldValue(field(GLOBAL_FIELDS, "server min protocol"), "smb2"), null);
        assert.notEqual(validateFieldValue(field(GLOBAL_FIELDS, "server min protocol"), "SMB4"), null);
        assert.equal(validateFieldValue(field(GLOBAL_FIELDS, "map to guest"), "bad user"), null);
        assert.notEqual(validateFieldValue(field(GLOBAL_FIELDS, "netbios name"), "A-NAME-THAT-IS-TOO-LONG"), null);
        assert.notEqual(validateFieldValue(field(GLOBAL_FIELDS, "max log size"), "-1"), null);
        assert.equal(validateFieldValue(field(GLOBAL_FIELDS, "workgroup"), ""), null);
    });

    test("users and passwords", () => {
        assert.equal(validateNewUserName("scanner"), null);
        assert.notEqual(validateNewUserName("Scanner"), null);
        assert.notEqual(validateNewUserName("-x"), null);
        assert.equal(validatePassword("s3cret", "s3cret"), null);
        assert.notEqual(validatePassword("a", "b"), null);
        assert.notEqual(validatePassword("", ""), null);
        assert.notEqual(validatePassword("a\nb", "a\nb"), null);
    });

    test("generated documents are checked, parsed lines are trusted", () => {
        const parsed = parseConfiguration("[s]\n   weird line\n");
        assert.deepEqual(validateDocument(parsed), []);
        const generated = { ...parsed, sections: [{ name: "x]y", headerRawLines: null, leadingLines: [], lines: [] }] };
        assert.equal(validateDocument(generated).length, 1);
    });
});
