// Minimal stand-in for the Cockpit API used by pure helpers under test.
const cockpit = {
    gettext: (text: string) => text,
    format: (template: string, ...args: unknown[]) =>
        template.replace(/\$(\d+)/g, (_match, index) => String(args[Number(index)])),
};

export default cockpit;
