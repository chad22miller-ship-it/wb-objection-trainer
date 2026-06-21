import { getUsageStats } from './chat.js';

export default function handler(req, res) {
  res.status(200).json(getUsageStats());
}
