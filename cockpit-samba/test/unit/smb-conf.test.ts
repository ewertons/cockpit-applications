import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canonicalParameterName, isSmb1OrOlder, parameterKey, parseBoolean, protocolLevelIndex } from "../../src/parameters.ts";
import {
    addSection,
    getParameter,
    getParameterValues,
    listParameters,
    listSectionNames,
    parseConfiguration,
    removeSection,
    renameSection,
    replaceParameters,
    serializeConfiguration,
    setParameter,
    setParameterValues,
} from "../../src/smb-conf.ts";

const DEBIAN_STYLE = `#
# Distribution-style smb.conf used to check lossless round trips.
#

#=================== Server-wide settings ====================

[global]

## Identity ###

# Name of the workgroup this server belongs to
   workgroup = WORKGROUP

#### Network ####

;   interfaces = 127.0.0.0/8 eth0
;   bind interfaces only = yes

   log file = /var/log/samba/log.%m
   max log size = 1000
   server role = standalone server
   map to guest = bad user
   usershare allow guests = yes

#=================== Shares ====================

;[homes]
;   comment = Home Directories
;   browseable = no

[printers]
   comment = All Printers
   browseable = no
   path = /var/tmp
   printable = yes
   guest ok = no
   read only = yes
   create mask = 0700

# Driver download share
# for Windows print clients
[print$]
   comment = Printer Drivers
   path = /var/lib/samba/printers
   browseable = yes
   read only = yes
   guest ok = no
# Enable to let these users upload drivers.
;   write list = root, @lpadmin
`;

describe("parameter names", () => {
    test("keys ignore case and whitespace", () => {
        assert.equal(parameterKey("Read  Only"), "readonly");
        assert.equal(parameterKey("readonly"), "readonly");
    });

    test("synonyms map to canonical names", () => {
        assert.equal(canonicalParameterName("writeable"), "read only");
        assert.equal(canonicalParameterName("Writable"), "read only");
        assert.equal(canonicalParameterName("browsable"), "browseable");
        assert.equal(canonicalParameterName("public"), "guest ok");
        assert.equal(canonicalParameterName("min protocol"), "server min protocol");
        assert.equal(canonicalParameterName("smb encrypt"), "server smb encrypt");
        assert.equal(canonicalParameterName("Some Custom"), "Some Custom");
    });

    test("booleans and protocol levels", () => {
        assert.equal(parseBoolean("Yes"), true);
        assert.equal(parseBoolean("off"), false);
        assert.equal(parseBoolean("maybe"), null);
        assert.ok(isSmb1OrOlder("NT1"));
        assert.ok(isSmb1OrOlder("lanman2"));
        assert.ok(!isSmb1OrOlder("SMB2"));
        assert.ok(!isSmb1OrOlder("default"));
        assert.equal(protocolLevelIndex("SMB3"), protocolLevelIndex("SMB3_11"));
    });
});

describe("smb.conf round trip", () => {
    const samples: Record<string, string> = {
        "Debian style": DEBIAN_STYLE,
        "empty": "",
        "no trailing newline": "[global]\n\tworkgroup = X",
        "CRLF": "[global]\r\n  workgroup = X\r\n\r\n[a]\r\n  path = /srv/a\r\n",
        "continuation": "[global]\n  valid users = alice \\\n     bob\n  # comment ending with \\\n  workgroup = W\n",
        "unparsed and stray": "stray text\n[global]\nno equals here\n  = value without name\n[ spaced name ] trailing junk\n",
        "includes": "[global]\n  include = /etc/samba/a.conf\n  include = /etc/samba/b.conf\n",
        "duplicate sections": "[a]\n path = /a\n[A]\n read only = no\n[a]\n path = /b\n",
    };
    for (const [name, text] of Object.entries(samples)) {
        test(`${name} is reproduced byte for byte`, () => {
            assert.equal(serializeConfiguration(parseConfiguration(text)), text);
        });
    }

    test("sections, comments and parameters are recognised", () => {
        const document = parseConfiguration(DEBIAN_STYLE);
        assert.deepEqual(listSectionNames(document), ["global", "printers", "print$"]);
        assert.equal(getParameter(document, "global", "workgroup"), "WORKGROUP");
        assert.equal(getParameter(document, "global", "interfaces"), undefined, "commented-out parameters are not read");
        assert.equal(getParameter(document, "print$", "write list"), undefined);
        assert.equal(document.sections[2].leadingLines.length, 2, "comment block directly above [print$] belongs to it");
    });

    test("continuation lines are joined", () => {
        const document = parseConfiguration("[s]\n  valid users = alice, \\\n    bob\n  path = /x\n");
        assert.equal(getParameter(document, "s", "valid users"), "alice,     bob");
        assert.equal(getParameter(document, "s", "path"), "/x");
    });

    test("comment lines never continue", () => {
        const document = parseConfiguration("[s]\n# note \\\n  path = /x\n");
        assert.equal(getParameter(document, "s", "path"), "/x");
    });

    test("parameters before the first section belong to [global]", () => {
        const document = parseConfiguration("workgroup = EARLY\n[global]\nserver string = s\n");
        assert.equal(getParameter(document, "global", "workgroup"), "EARLY");
        assert.equal(getParameter(document, "GLOBAL", "Server String"), "s");
    });
});

describe("reading parameters", () => {
    test("keys are case- and space-insensitive", () => {
        const document = parseConfiguration("[s]\n  ReadOnly = no\n");
        assert.equal(getParameter(document, "S", "read only"), "no");
    });

    test("inverted synonyms are translated", () => {
        assert.equal(getParameter(parseConfiguration("[s]\nwriteable = yes\n"), "s", "read only"), "no");
        assert.equal(getParameter(parseConfiguration("[s]\nwritable = no\n"), "s", "read only"), "yes");
        assert.equal(getParameter(parseConfiguration("[s]\nwrite ok = yes\n"), "s", "read only"), "no");
        assert.equal(getParameter(parseConfiguration("[s]\nread only = no\n"), "s", "writable"), "yes");
    });

    test("the last occurrence wins, across synonyms and repeated sections", () => {
        const document = parseConfiguration("[s]\nread only = yes\nwriteable = yes\n[other]\n[S]\nbrowsable = no\n");
        assert.equal(getParameter(document, "s", "read only"), "no");
        assert.equal(getParameter(document, "s", "browseable"), "no");
    });
});

describe("editing parameters", () => {
    test("changing a value keeps every other line intact", () => {
        const document = setParameter(parseConfiguration(DEBIAN_STYLE), "global", "workgroup", "HOME");
        const expected = DEBIAN_STYLE.replace("   workgroup = WORKGROUP", "   workgroup = HOME");
        assert.equal(serializeConfiguration(document), expected);
    });

    test("an unchanged value keeps the original formatting", () => {
        const text = "[s]\n  Read Only=   no   \n";
        assert.equal(serializeConfiguration(setParameter(parseConfiguration(text), "s", "read only", "no")), text);
    });

    test("an inverted synonym keeps its spelling and gets the inverted value", () => {
        const document = setParameter(parseConfiguration("[s]\n   writeable = yes\n"), "s", "read only", "yes");
        assert.equal(serializeConfiguration(document), "[s]\n   writeable = no\n");
    });

    test("duplicates and synonyms collapse into one line", () => {
        const document = setParameter(parseConfiguration("[s]\n read only = yes\n path = /x\n writable = yes\n"), "s", "read only", "no");
        assert.equal(serializeConfiguration(document), "[s]\n read only = no\n path = /x\n");
    });

    test("new parameters go after the last parameter, with the section's indentation", () => {
        const text = "[s]\n   path = /x\n;   write list = old\n\n[t]\n";
        const document = setParameter(parseConfiguration(text), "s", "valid users", "@staff");
        assert.equal(serializeConfiguration(document), "[s]\n   path = /x\n   valid users = @staff\n;   write list = old\n\n[t]\n");
    });

    test("removing a parameter removes all its synonyms", () => {
        const document = setParameter(parseConfiguration("[s]\n public = yes\n guest ok = yes\n path = /x\n"), "s", "guest ok", null);
        assert.equal(serializeConfiguration(document), "[s]\n path = /x\n");
    });

    test("setting a parameter in a missing section creates it; [global] goes first", () => {
        const document = setParameter(parseConfiguration("# header\n\n[data]\n\tpath = /d\n"), "global", "workgroup", "W");
        assert.equal(serializeConfiguration(document), "# header\n\n[global]\n\tworkgroup = W\n[data]\n\tpath = /d\n");
        assert.equal(serializeConfiguration(setParameter(parseConfiguration(""), "new", "path", "/n")), "[new]\n\tpath = /n\n");
    });

    test("repeatable parameters such as include keep every occurrence", () => {
        const text = "[global]\n include = /a.conf\n include = /b.conf\n";
        const document = setParameter(parseConfiguration(text), "global", "include", "/c.conf");
        assert.deepEqual(getParameterValues(document, "global", "include"), ["/a.conf", "/c.conf"]);
        const three = setParameterValues(parseConfiguration(text), "global", "include", ["/a.conf", "/b.conf", "/z.conf"]);
        assert.equal(serializeConfiguration(three), text + " include = /z.conf\n");
    });

    test("generic replacement only rewrites changed keys", () => {
        const text = "[s]\n  path = /x\n  vfs objects = recycle\n  recycle:repository = .trash\n  include = /a\n  include = /b\n";
        const document = parseConfiguration(text);
        const parameters = listParameters(document, "s")
                .filter(parameter => parameter.name !== "vfs objects")
                .map(parameter => parameter.name === "recycle:repository" ? { ...parameter, value: ".bin" } : parameter);
        parameters.push({ name: "fruit:metadata", value: "stream" });
        const result = serializeConfiguration(replaceParameters(document, "s", parameters));
        assert.equal(result, "[s]\n  path = /x\n  recycle:repository = .bin\n  include = /a\n  include = /b\n  fruit:metadata = stream\n");
    });
});

describe("editing sections", () => {
    test("removing a section removes its leading comments and repeated occurrences", () => {
        const result = serializeConfiguration(removeSection(parseConfiguration(DEBIAN_STYLE), "print$"));
        assert.ok(!result.includes("[print$]"));
        assert.ok(!result.includes("printer drivers"));
        assert.ok(result.includes("[printers]"));
        assert.equal(serializeConfiguration(removeSection(parseConfiguration("[a]\nx = 1\n[b]\n[A]\ny = 2\n"), "a")), "[b]\n");
    });

    test("adding and renaming sections", () => {
        let document = addSection(parseConfiguration("[global]\n\tworkgroup = W\n"), "data");
        document = setParameter(document, "data", "path", "/srv/data");
        assert.equal(serializeConfiguration(document), "[global]\n\tworkgroup = W\n\n[data]\n\tpath = /srv/data\n");
        document = renameSection(document, "DATA", "files");
        assert.equal(serializeConfiguration(document), "[global]\n\tworkgroup = W\n\n[files]\n\tpath = /srv/data\n");
    });

    test("editing never mutates the original document", () => {
        const original = parseConfiguration(DEBIAN_STYLE);
        setParameter(original, "printers", "path", "/tmp");
        removeSection(original, "printers");
        assert.equal(serializeConfiguration(original), DEBIAN_STYLE);
    });
});
