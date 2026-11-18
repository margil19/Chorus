import fs from 'fs'
import path from 'path'

export const EVAL_DIR = path.resolve(process.cwd(), 'scripts/eval')

const questionsArg = process.argv.indexOf('--questions')
export const questions: string[] = JSON.parse(
  fs.readFileSync(questionsArg >= 0 ? path.resolve(process.argv[questionsArg + 1]) : path.join(EVAL_DIR, 'questions.json'), 'utf8')
)
