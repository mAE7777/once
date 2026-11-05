// Unpacks the prepared sample texts on first install, so the app works before any key is set.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (!existsSync('data/once.db') && existsSync('samples/data.tar.gz')) {
  execFileSync('tar', ['-xzf', 'samples/data.tar.gz'])
  console.log('Sample texts are ready.')
}
