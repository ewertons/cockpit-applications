import React, { useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

export interface WizardStepDef {
    id: string;
    name: string;
    content: React.ReactNode;
    // When false, the Next/Finish button for this step is disabled.
    canContinue?: boolean;
    hideBack?: boolean;
    nextLabel?: string;
    cancelLabel?: string;
    // Runs when leaving the step via Next. Return false to stay on the step.
    // May throw to surface an error and stay.
    onNext?: () => Promise<boolean | void> | boolean | void;
}

interface StepWizardProps {
    title: string;
    steps: WizardStepDef[];
    onClose: () => void;
    onFinish: () => void | Promise<void>;
    finishLabel?: string;
    variant?: "small" | "medium" | "large";
    error?: string | null;
}

// A lightweight multi-step wizard rendered inside a standard PatternFly Modal,
// matching the dialog styling used across the other Cockpit apps in this repo.
export function StepWizard({ title, steps, onClose, onFinish, finishLabel, variant = "medium", error }: StepWizardProps) {
    const [index, setIndex] = useState(0);
    const [busy, setBusy] = useState(false);
    const [localError, setLocalError] = useState<string | null>(null);

    const step = steps[index];
    const isLast = index === steps.length - 1;

    const go = async (dir: 1 | -1) => {
        setLocalError(null);
        if (dir === 1) {
            if (step.onNext) {
                setBusy(true);
                try {
                    const ok = await step.onNext();
                    setBusy(false);
                    if (ok === false)
                        return;
                } catch (e: unknown) {
                    setBusy(false);
                    setLocalError(e instanceof Error ? e.message : String(e));
                    return;
                }
            }
            setIndex(i => Math.min(i + 1, steps.length - 1));
        } else {
            setIndex(i => Math.max(i - 1, 0));
        }
    };

    const finish = async () => {
        setLocalError(null);
        setBusy(true);
        try {
            await onFinish();
        } catch (e: unknown) {
            setBusy(false);
            setLocalError(e instanceof Error ? e.message : String(e));
            return;
        }
        setBusy(false);
    };

    const shownError = error || localError;

    return (
        <Modal variant={variant} isOpen onClose={onClose}>
            <ModalHeader title={title} />
            <ModalBody>
                {steps.length > 1 && (
                    <ol className="wg-wizard-steps">
                        {steps.map((s, i) => (
                            <li
                                key={s.id}
                                className={"wg-wizard-step" +
                                    (i === index ? " active" : "") +
                                    (i < index ? " done" : "")}
                            >
                                <span className="wg-wizard-step-num">{i + 1}</span>
                                <span className="wg-wizard-step-name">{s.name}</span>
                            </li>
                        ))}
                    </ol>
                )}

                {shownError && (
                    <Alert variant="danger" title={_("Error")} isInline style={{ marginBottom: "1rem" }}>
                        {shownError}
                    </Alert>
                )}

                <div className="wg-wizard-content">
                    {step.content}
                </div>
            </ModalBody>
            <ModalFooter>
                {!isLast
                    ? (
                        <Button
                            variant="primary"
                            onClick={() => go(1)}
                            isDisabled={busy || step.canContinue === false}
                            isLoading={busy}
                        >
                            {step.nextLabel || _("Next")}
                        </Button>
                    )
                    : (
                        <Button
                            variant="primary"
                            onClick={finish}
                            isDisabled={busy || step.canContinue === false}
                            isLoading={busy}
                        >
                            {finishLabel || _("Finish")}
                        </Button>
                    )}
                {index > 0 && !step.hideBack && (
                    <Button variant="secondary" onClick={() => go(-1)} isDisabled={busy}>
                        {_("Back")}
                    </Button>
                )}
                <Button variant="link" onClick={onClose} isDisabled={busy}>
                    {step.cancelLabel || _("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
}
