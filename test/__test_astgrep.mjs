import { isAstGrepAvailable, findWithPattern, replaceWithPattern, astGrepPatternToTreeSitterQuery, ASTGREP_AVAILABLE } from '../src/astgrep-anchor.ts';

console.log('ASTGREP_AVAILABLE:', ASTGREP_AVAILABLE);
const avail = await isAstGrepAvailable();
console.log('isAstGrepAvailable:', avail);
console.log('findWithPattern empty:', JSON.stringify(await findWithPattern('hello world', 'typescript', '')));
console.log('replaceWithPattern null:', JSON.stringify(await replaceWithPattern('hello world', 'typescript', '', '')));
console.log('query conversion:', astGrepPatternToTreeSitterQuery('$METHOD($ARGS)'));
console.log('query conversion simple:', astGrepPatternToTreeSitterQuery('$NAME'));
console.log('query conversion multi:', astGrepPatternToTreeSitterQuery('$$$ARGS'));
console.log('query conversion null empty:', astGrepPatternToTreeSitterQuery(''));
console.log('query conversion null complex:', astGrepPatternToTreeSitterQuery('[a-z]'));
