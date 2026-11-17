/** Minimal line diff (longest common subsequence) for the apply preview. */

export interface DiffLine {
    kind: "same" | "added" | "removed";
    text: string;
}

/** @returns the line-by-line difference turning `before` into `after`. */
export function diffLines(before: string, after: string): DiffLine[] {
    const oldLines = before === "" ? [] : before.replace(/\n$/, "").split("\n");
    const newLines = after === "" ? [] : after.replace(/\n$/, "").split("\n");
    const lengths: number[][] = Array.from({ length: oldLines.length + 1 }, () => new Array(newLines.length + 1).fill(0));
    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--)
        for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--)
            lengths[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
                ? lengths[oldIndex + 1][newIndex + 1] + 1
                : Math.max(lengths[oldIndex + 1][newIndex], lengths[oldIndex][newIndex + 1]);

    const result: DiffLine[] = [];
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldLines.length && newIndex < newLines.length) {
        if (oldLines[oldIndex] === newLines[newIndex]) {
            result.push({ kind: "same", text: oldLines[oldIndex] });
            oldIndex++;
            newIndex++;
        } else if (lengths[oldIndex + 1][newIndex] >= lengths[oldIndex][newIndex + 1]) {
            result.push({ kind: "removed", text: oldLines[oldIndex++] });
        } else {
            result.push({ kind: "added", text: newLines[newIndex++] });
        }
    }
    while (oldIndex < oldLines.length)
        result.push({ kind: "removed", text: oldLines[oldIndex++] });
    while (newIndex < newLines.length)
        result.push({ kind: "added", text: newLines[newIndex++] });
    return result;
}
