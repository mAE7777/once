export const strings = {
  title: 'Recall sheet',
  loading: 'Putting your recall sheet together.',
  loadFailed: 'Your recall sheet could not be loaded.',
  retry: 'Try again',
  empty: 'Nothing to recall yet. Your notes and answers will collect here as you read.',
  noPlan:
    'The explanation has not been made in this language yet, so the problem chain and terms are not here.',
  problemChain: 'The problem chain',
  ownWords: 'In your own words',
  notes: 'Your notes',
  terms: 'Terms',
  page: (page: number): string => `Page ${page}`,
  dropped: (count: number): string =>
    count === 1
      ? '1 entry was left out because its sentence is not in this text.'
      : `${count} entries were left out because their sentences are not in this text.`,
}
