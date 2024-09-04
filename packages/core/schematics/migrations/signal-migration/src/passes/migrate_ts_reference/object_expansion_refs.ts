/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import ts from 'typescript';
import {
  projectRelativePath,
  ProjectRelativePath,
  Replacement,
  TextUpdate,
} from '../../../../../utils/tsurge/replacement';
import {getBindingElementDeclaration} from '../../utils/binding_elements';
import {AbsoluteFsPath} from '@angular/compiler-cli/src/ngtsc/file_system';
import {UniqueNamesGenerator} from '../../utils/unique_names';
import assert from 'assert';
import {MigrationResult} from '../../result';

/** An identifier part of a binding element. */
export interface IdentifierOfBindingElement extends ts.Identifier {
  parent: ts.BindingElement;
}

/**
 * Migrates a binding element that refers to an Angular input.
 *
 * E.g. `const {myInput} = this`.
 *
 * For references in binding elements, we extract the element into a variable
 * where we unwrap the input. This ensures narrowing naturally works in subsequent
 * places, and we also don't need to detect potential aliases.
 *
 * ```ts
 *   const {myInput} = this;
 *   // turns into
 *   const {myInput: myInputValue} = this;
 *   const myInput = myInputValue();
 * ```
 */
export function migrateBindingElementInputReference(
  tsReferencesInBindingElements: Set<IdentifierOfBindingElement>,
  projectDirAbsPath: AbsoluteFsPath,
  nameGenerator: UniqueNamesGenerator,
  result: MigrationResult,
) {
  for (const reference of tsReferencesInBindingElements) {
    const bindingElement = reference.parent;
    const bindingDecl = getBindingElementDeclaration(bindingElement);

    const sourceFile = bindingElement.getSourceFile();
    const filePath = projectRelativePath(sourceFile.fileName, projectDirAbsPath);

    const inputFieldName = bindingElement.propertyName ?? bindingElement.name;
    assert(
      !ts.isObjectBindingPattern(inputFieldName) && !ts.isArrayBindingPattern(inputFieldName),
      'Property of binding element cannot be another pattern.',
    );

    const tmpName: string | undefined = nameGenerator.generate(reference.text, bindingElement);
    // Only use the temporary name, if really needed. A temporary name is needed if
    // the input field simply aliased via the binding element, or if the exposed identifier
    // is a string-literal like.
    const useTmpName =
      !ts.isObjectBindingPattern(bindingElement.name) || !ts.isIdentifier(inputFieldName);

    const propertyName = useTmpName ? inputFieldName : undefined;
    const exposedName = useTmpName ? ts.factory.createIdentifier(tmpName) : inputFieldName;
    const newBinding = ts.factory.updateBindingElement(
      bindingElement,
      bindingElement.dotDotDotToken,
      propertyName,
      exposedName,
      bindingElement.initializer,
    );

    const temporaryVariableReplacements = insertTemporaryVariableForBindingElement(
      bindingDecl,
      filePath,
      `const ${bindingElement.name.getText()} = ${tmpName}();`,
    );
    if (temporaryVariableReplacements === null) {
      console.error(`Could not migrate reference ${reference.text} in ${filePath}`);
      continue;
    }

    result.replacements.push(
      new Replacement(
        filePath,
        new TextUpdate({
          position: bindingElement.getStart(),
          end: bindingElement.getEnd(),
          toInsert: result.printer.printNode(ts.EmitHint.Unspecified, newBinding, sourceFile),
        }),
      ),
      ...temporaryVariableReplacements,
    );
  }
}

/**
 * Inserts the given code snippet after the given variable or
 * parameter declaration.
 *
 * If this is a parameter of an arrow function, a block may be
 * added automatically.
 */
function insertTemporaryVariableForBindingElement(
  expansionDecl: ts.VariableDeclaration | ts.ParameterDeclaration,
  filePath: ProjectRelativePath,
  toInsert: string,
): Replacement[] | null {
  const sf = expansionDecl.getSourceFile();
  const parent = expansionDecl.parent;

  // The snippet is simply inserted after the variable declaration.
  // The other case of a variable declaration inside a catch clause is handled
  // below.
  if (ts.isVariableDeclaration(expansionDecl) && ts.isVariableDeclarationList(parent)) {
    const leadingSpaceCount = ts.getLineAndCharacterOfPosition(sf, parent.getStart()).character;
    const leadingSpace = ' '.repeat(leadingSpaceCount);
    const statement: ts.Statement = parent.parent;

    return [
      new Replacement(
        filePath,
        new TextUpdate({
          position: statement.getEnd(),
          end: statement.getEnd(),
          toInsert: `\n${leadingSpace}${toInsert}`,
        }),
      ),
    ];
  }

  // If we are dealing with a object expansion inside a parameter of
  // a function-like declaration w/ block, add the variable as the first
  // node inside the block.
  const bodyBlock = getBodyBlockOfNode(parent);
  if (bodyBlock !== null) {
    const firstElementInBlock = bodyBlock.statements[0] as ts.Statement | undefined;
    const spaceReferenceNode = firstElementInBlock ?? bodyBlock;
    const spaceOffset = firstElementInBlock !== undefined ? 0 : 2;

    const leadingSpaceCount =
      ts.getLineAndCharacterOfPosition(sf, spaceReferenceNode.getStart()).character + spaceOffset;
    const leadingSpace = ' '.repeat(leadingSpaceCount);

    return [
      new Replacement(
        filePath,
        new TextUpdate({
          position: bodyBlock.getStart() + 1,
          end: bodyBlock.getStart() + 1,
          toInsert: `\n${leadingSpace}${toInsert}`,
        }),
      ),
    ];
  }

  // Other cases where we see an arrow function without a block.
  // We need to create one now.
  if (ts.isArrowFunction(parent) && !ts.isBlock(parent.body)) {
    // For indentation, we traverse up and find the earliest statement.
    // This node is most of the time a good candidate for acceptable
    // indentation of a new block.
    const spacingNode = ts.findAncestor(parent, ts.isStatement) ?? parent.parent;
    const {character} = ts.getLineAndCharacterOfPosition(sf, spacingNode.getStart());
    const blockSpace = ' '.repeat(character);
    const contentSpace = ' '.repeat(character + 2);

    return [
      new Replacement(
        filePath,
        new TextUpdate({
          position: parent.body.getStart(),
          end: parent.body.getEnd(),
          toInsert: `{\n${contentSpace}${toInsert}\n${contentSpace}return ${parent.body.getText()};`,
        }),
      ),
      new Replacement(
        filePath,
        new TextUpdate({
          position: parent.body.getEnd(),
          end: parent.body.getEnd(),
          toInsert: `\n${blockSpace}}`,
        }),
      ),
    ];
  }

  return null;
}

/** Gets the body block of a given node, if available. */
function getBodyBlockOfNode(node: ts.Node): ts.Block | null {
  if (
    (ts.isMethodDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isArrowFunction(node)) &&
    node.body !== undefined &&
    ts.isBlock(node.body)
  ) {
    return node.body;
  }
  if (ts.isCatchClause(node.parent)) {
    return node.parent.block;
  }
  return null;
}