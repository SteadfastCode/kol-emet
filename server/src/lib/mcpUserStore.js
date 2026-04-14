import Settings from '../models/Settings.js';

export async function setMcpUser(userId) {
  await Settings.findByIdAndUpdate(
    'global',
    { mcpUserId: userId },
    { upsert: true, new: true }
  );
}

export async function getMcpUser() {
  const settings = await Settings.findById('global').lean();
  return settings?.mcpUserId ? String(settings.mcpUserId) : null;
}
