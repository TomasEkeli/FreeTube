import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml } from 'js-yaml'

const localesPath = join(import.meta.dirname, '..', 'static', 'locales')
const defaultLocale = 'en-US.yaml'

const errors = [

]

const defaultData = loadYaml(readFileSync(`${localesPath}/${defaultLocale}`, { encoding: 'utf-8' }))
const defaultKeys = Object.keys(defaultData)

const filesInLocaleDir = readdirSync(localesPath)

for (const file of filesInLocaleDir) {
  if (file !== defaultLocale && file.endsWith('.yaml')) {
    const fileData = loadYaml(readFileSync(`${localesPath}/${file}`, { encoding: 'utf-8' }))
    const fileDataKeys = Object.keys(fileData)
    addErrors(defaultData, fileData, defaultKeys, fileDataKeys, file)
  }
}

writeFileSync('locale-errors.json', JSON.stringify(errors, null, 2))

if (errors.length > 0) {
  console.error(errors)
} else {
  console.log('no issues found')
}

/**
 * @param {unknown} originalData - data from en-US converted to a JavaScript object
 * @param {unknown} newData - data from the file we are analyzing converted to a JavaScript object
 * @param {string[]} originalKeys - keys from en-US file
 * @param {string[]} newKeys - keys from the file we are currently analyzing
 * @param {string} file - the file we are currently analyzing
 */
function addErrors(originalData, newData, originalKeys, newKeys, file) {
  newKeys.forEach(newKey => {
    if (!originalKeys.includes(newKey)) {
      // The key doesn't exist in the en-US file but exists in current yaml file.
      // We should go through this eventually but it's not as important as invalid templates

      // errors.push({ fileName: file, error: 'extra key found', key: fdk })
      return
    }

    const originalValue = originalData[newKey]
    const newValue = newData[newKey]

    // A key written with nothing after the colon parses as null, and null is
    // an object as far as `typeof` is concerned. Descending into one used to
    // end the whole run on `Object.keys(null)`, so a single malformed entry in
    // one locale hid every real problem in all the others. It is now reported
    // as the fault it is, and the walk carries on.
    if (isSection(originalValue) !== isSection(newValue)) {
      errors.push({
        fileName: file,
        error: isSection(originalValue)
          ? 'expected a group of translations, found a single value or nothing'
          : 'expected a single translation, found a group',
        key: newKey,
        value: newValue
      })
      return
    }

    if (isSection(originalValue)) {
      addErrors(originalValue, newValue, Object.keys(originalValue), Object.keys(newValue), file)
      return
    }

    if (typeof newValue !== 'string') {
      errors.push({ fileName: file, error: 'value is empty or is not text', key: newKey, defaultValue: originalValue, value: newValue })
      return
    }

    if (isMissingInterpolation(originalValue, newValue, file)) {
      errors.push({ fileName: file, error: 'value is missing a template or has an extra template', key: newKey, defaultValue: originalValue, value: newValue })
    }
  })
}

/**
 * Whether this is a group of translations rather than one translation.
 *
 * `typeof null` is `'object'`, so the null a valueless key parses into has to
 * be excluded by hand.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isSection(value) {
  return value !== null && typeof value === 'object'
}

/**
 *
 * @param {String} defaultValue
 * @param {String} otherValue
 */
function isMissingInterpolation(defaultValue, otherValue, filename) {
  if (otherValue === '') {
    // not translated yet, we don't care
    return false
  }
  const defaultMatches = Array.from(new Set(defaultValue.match(/{[^}]*}/g)))
  const otherMatches = Array.from(new Set(otherValue.match(/{[^}]*}/g)))

  if (defaultMatches) {
    if (!otherMatches) {
      // no templates found.
      return true
    }
    defaultMatches.sort()
    otherMatches.sort()

    const defaultMatchesStringified = JSON.stringify(defaultMatches)
    const otherMatchesStringified = JSON.stringify(otherMatches)
    // check if templates match.
    return defaultMatchesStringified !== otherMatchesStringified
  } else if (otherMatches) {
    // extra template found
    return true
  }
}
