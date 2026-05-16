# extract name from package.json
PACKAGE_NAME := $(shell awk '/"name":/ {gsub(/[",]/, "", $$2); print $$2}' package.json)
RPM_NAME := cockpit-$(PACKAGE_NAME)
VERSION := $(shell T=$$(git describe 2>/dev/null) || T=1; echo $$T | tr '-' '.')
ifeq ($(TEST_OS),)
TEST_OS = centos-9-stream
endif
export TEST_OS
TARFILE=$(RPM_NAME)-$(VERSION).tar.xz
NODE_CACHE=$(RPM_NAME)-node-$(VERSION).tar.xz
SPEC=$(RPM_NAME).spec
PREFIX ?= /usr/local
VM_IMAGE=$(CURDIR)/test/images/$(TEST_OS)
NODE_MODULES_TEST=package-lock.json
DIST_TEST=runtime-npm-modules.txt
COCKPIT_REPO_STAMP=pkg/lib/cockpit-po-plugin.js
TAR_ARGS = --sort=name --mtime "@$(shell git show --no-patch --format='%at')" --mode=go=rX,u+rw,a-s --numeric-owner --owner=0 --group=0

all: $(DIST_TEST)

COCKPIT_REPO_FILES = \
	pkg/lib \
	$(NULL)

COCKPIT_REPO_URL = https://github.com/cockpit-project/cockpit.git
COCKPIT_REPO_COMMIT = 1e248cdea10ec81eaf64a664b85c4a16991e9137 # 361 + 57 commits

$(COCKPIT_REPO_FILES): $(COCKPIT_REPO_STAMP)
COCKPIT_REPO_TREE = '$(strip $(COCKPIT_REPO_COMMIT))^{tree}'
$(COCKPIT_REPO_STAMP): Makefile
	@git rev-list --quiet --objects $(COCKPIT_REPO_TREE) -- 2>/dev/null || \
	    git fetch --no-tags --no-write-fetch-head --depth=1 $(COCKPIT_REPO_URL) $(COCKPIT_REPO_COMMIT)
	git -C "$$(git rev-parse --show-toplevel)" archive $(COCKPIT_REPO_TREE) -- $(COCKPIT_REPO_FILES) | tar x

#
# i18n
#

LINGUAS=$(basename $(notdir $(wildcard po/*.po)))

po/po.js: $(addprefix po/po.,$(addsuffix .js,$(LINGUAS)))
	cat $^ > $@

po/po.%.js: po/%.po
	pkg/lib/html2po --from-po $< > $@

#
# Build
#

$(NODE_MODULES_TEST): package.json
	npm install --ignore-scripts
	@touch $@

$(DIST_TEST): $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP) $(shell find src/ -type f) package.json build.js
	NODE_ENV=$(if $(production),production,development) ./build.js

watch:
	ESBUILD_WATCH=true ./build.js

clean:
	rm -rf dist/ metafile.json runtime-npm-modules.txt

install: $(DIST_TEST)
	mkdir -p $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)
	cp -r dist/* $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)/

.PHONY: all watch clean install
