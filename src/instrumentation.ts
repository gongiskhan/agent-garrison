export async function register() {
  if(process.env.NEXT_RUNTIME!=='nodejs' || process.env.NEXT_PHASE==='phase-production-build' || process.env.GARRISON_DISABLE_HOST_DAEMONS==='1' || process.env.GARRISON_MESSAGES_DISABLE_WORKERS==='1') return;
  const {stateEnrolled}=await import('./lib/state-client');
  if(!stateEnrolled()) return;
  const {ensureMessagesRuntime}=await import('./lib/messages-runtime');
  await ensureMessagesRuntime();
}
