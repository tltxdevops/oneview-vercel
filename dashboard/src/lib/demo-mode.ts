const demoModeValue = import.meta.env.NEXT_PUBLIC_DEMO_MODE?.trim().toLowerCase();

export const isDemoMode = demoModeValue === "true";
