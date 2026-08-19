// The .py loader in build.js bundles Python helpers as plain strings.
declare module "*.py" {
    const content: string;
    export default content;
}

// pkg/lib/superuser.js is plain JS that does not survive checkJs, so
// cockpit.permission is declared here instead. It exists at runtime but is
// missing from the vendored cockpit.d.ts.
declare module 'cockpit' {
    interface Permission {
        allowed: boolean | null;
        addEventListener(event: "changed", handler: () => void): void;
        removeEventListener(event: "changed", handler: () => void): void;
        close(): void;
    }
    function permission(options: { admin?: boolean }): Permission;
}
