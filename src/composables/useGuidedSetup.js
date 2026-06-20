import { reactive } from "vue";

const GUIDED_SETUP_STORAGE_KEY = "designcode.guidedSetup.completed";
const MAX_STEP_INDEX = 2;

function readCompletedPreference() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(GUIDED_SETUP_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

const guidedSetup = reactive({
  open: false,
  activeStep: 0,
  completed: readCompletedPreference()
});

function clampStep(step) {
  const next = Number(step);
  if (!Number.isFinite(next)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_STEP_INDEX, Math.round(next)));
}

function openGuidedSetup(step = 0) {
  guidedSetup.activeStep = clampStep(step);
  guidedSetup.open = true;
}

function closeGuidedSetup() {
  guidedSetup.open = false;
}

function setGuidedSetupStep(step) {
  guidedSetup.activeStep = clampStep(step);
}

function markGuidedSetupCompleted() {
  guidedSetup.completed = true;
  try {
    window.localStorage.setItem(GUIDED_SETUP_STORAGE_KEY, "1");
  } catch {}
}

export function useGuidedSetup() {
  return {
    guidedSetup,
    openGuidedSetup,
    closeGuidedSetup,
    setGuidedSetupStep,
    markGuidedSetupCompleted
  };
}
