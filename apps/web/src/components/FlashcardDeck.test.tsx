// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FlashcardDeck } from './FlashcardDeck';
import type { FlashcardSet } from '@notebook/shared';

const SET: FlashcardSet = {
  cards: [
    { id: 'a', question: 'Q1', answer: 'A1' },
    { id: 'b', question: 'Q2', answer: 'A2' },
    { id: 'c', question: 'Q3', answer: 'A3' },
  ],
};

afterEach(cleanup);

describe('FlashcardDeck', () => {
  it('renders the first card by default and shows the question', () => {
    render(<FlashcardDeck data={SET} />);
    const deck = screen.getByTestId('flashcard-deck');
    expect(within(deck).getByText('Q1')).toBeInTheDocument();
    // Answer hidden until flipped.
    expect(within(deck).queryByText('A1')).toBeNull();
    expect(within(deck).getByText('1 / 3')).toBeInTheDocument();
  });

  it('flips the card on click, showing the answer', () => {
    render(<FlashcardDeck data={SET} />);
    const card = screen.getByTestId('flashcard-card');
    expect(card.getAttribute('data-flipped')).toBe('false');
    fireEvent.click(card);
    expect(card.getAttribute('data-flipped')).toBe('true');
    expect(within(card).getByText('A1')).toBeInTheDocument();
  });

  it('advances to the next card on next-button click', () => {
    render(<FlashcardDeck data={SET} />);
    fireEvent.click(screen.getByTestId('flashcard-next'));
    expect(within(screen.getByTestId('flashcard-deck')).getByText('Q2')).toBeInTheDocument();
    expect(within(screen.getByTestId('flashcard-deck')).getByText('2 / 3')).toBeInTheDocument();
  });

  it('wraps around at the end (last → first on next, first → last on prev)', () => {
    render(<FlashcardDeck data={SET} />);
    fireEvent.click(screen.getByTestId('flashcard-next'));
    fireEvent.click(screen.getByTestId('flashcard-next'));
    expect(within(screen.getByTestId('flashcard-deck')).getByText('Q3')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('flashcard-next'));
    expect(within(screen.getByTestId('flashcard-deck')).getByText('Q1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('flashcard-prev'));
    expect(within(screen.getByTestId('flashcard-deck')).getByText('Q3')).toBeInTheDocument();
  });

  it('resets flip state when navigating', () => {
    render(<FlashcardDeck data={SET} />);
    fireEvent.click(screen.getByTestId('flashcard-card')); // flip
    expect(screen.getByTestId('flashcard-card').getAttribute('data-flipped')).toBe('true');
    fireEvent.click(screen.getByTestId('flashcard-next'));
    expect(screen.getByTestId('flashcard-card').getAttribute('data-flipped')).toBe('false');
  });

  it('marks a card as known, auto-advances, and updates the progress count', () => {
    render(<FlashcardDeck data={SET} />);
    fireEvent.click(screen.getByTestId('flashcard-known'));
    // Auto-advanced to Q2.
    expect(within(screen.getByTestId('flashcard-deck')).getByText('Q2')).toBeInTheDocument();
    // Progress label includes "1 знаю".
    expect(within(screen.getByTestId('flashcard-deck')).getByText(/1 знаю/)).toBeInTheDocument();
  });

  it('marks a card as unknown with the correct counter', () => {
    render(<FlashcardDeck data={SET} />);
    fireEvent.click(screen.getByTestId('flashcard-unknown'));
    expect(within(screen.getByTestId('flashcard-deck')).getByText(/1 не знаю/)).toBeInTheDocument();
  });

  it('resets state when "Сбросить" is clicked', () => {
    render(<FlashcardDeck data={SET} />);
    fireEvent.click(screen.getByTestId('flashcard-known'));
    fireEvent.click(screen.getByTestId('flashcard-next'));
    fireEvent.click(screen.getByTestId('flashcard-unknown'));
    fireEvent.click(screen.getByTestId('flashcard-next')); // Q3
    fireEvent.click(screen.getByTestId('flashcard-known'));
    // Now we're at the end (3/3), and the progress label has 1 known / 1 unknown.
    expect(within(screen.getByTestId('flashcard-deck')).getByText(/1 знаю/)).toBeInTheDocument();
    // Reset.
    fireEvent.click(screen.getByTestId('flashcard-deck').querySelector('button[title="Сбросить прогресс"]') as HTMLElement);
    expect(within(screen.getByTestId('flashcard-deck')).getByText('1 / 3')).toBeInTheDocument();
  });

  it('parses a JSON-string body (legacy / shared view)', () => {
    render(<FlashcardDeck data={JSON.stringify(SET)} />);
    expect(within(screen.getByTestId('flashcard-deck')).getByText('Q1')).toBeInTheDocument();
  });

  it('shows an empty-state placeholder for invalid JSON', () => {
    render(<FlashcardDeck data="not a json" />);
    expect(screen.getByTestId('flashcard-empty')).toBeInTheDocument();
  });
});
