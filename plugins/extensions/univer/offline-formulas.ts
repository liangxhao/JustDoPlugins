import { BaseFunction, ErrorType, ErrorValueObject } from '@univerjs/engine-formula';

/** Disable the built-in remote image loader through the public function config. */
class OfflineImage extends BaseFunction {
  override calculate() { return ErrorValueObject.create(ErrorType.NAME); }
}
export const offlineFormulaFunctions: Array<[typeof OfflineImage, 'IMAGE']> = [[OfflineImage, 'IMAGE']];
