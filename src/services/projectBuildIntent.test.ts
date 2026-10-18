import { describe, expect, it } from 'vitest';
import { isProjectBuildRequest } from './projectBuildIntent.js';

describe('project chat build intent', () => {
  it.each([
    'make a calculator',
    'Please create a settings page',
    'Could you add a dark mode toggle?',
    'Help me build an inventory tracker',
    '/build refactor the project navigation'
  ])('routes a clear implementation request to the orchestrator: %s', request => {
    expect(isProjectBuildRequest(request)).toBe(true);
  });

  it.each([
    'How does the calculator work?',
    'Show me an HTML example of a calculator',
    'Could you write a calculator code snippet?',
    'Give me a sample calculator in HTML',
    'What framework does this project use?',
    'I like the current calculator'
  ])('keeps a question or example request conversational: %s', request => {
    expect(isProjectBuildRequest(request)).toBe(false);
  });
});
