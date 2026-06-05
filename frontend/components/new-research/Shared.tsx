"use client";

import { useState, type KeyboardEvent } from "react";
import { X, Clock } from "lucide-react";

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  maxTags?: number;
}

export function TagInput({ tags, onChange, placeholder = "Type and press Enter", maxTags = 10 }: TagInputProps) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const trimmed = input.trim();
    if (trimmed && !tags.includes(trimmed) && tags.length < maxTags) {
      onChange([...tags, trimmed]);
      setInput("");
    }
  };

  const removeTag = (index: number) => {
    onChange(tags.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    } else if (e.key === "Backspace" && !input && tags.length > 0) {
      removeTag(tags.length - 1);
    }
  };

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-2">
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {tags.map((tag, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300"
          >
            {tag}
            <button type="button" onClick={() => removeTag(i)} className="text-zinc-500 hover:text-zinc-300">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={addTag}
        placeholder={tags.length >= maxTags ? `Max ${maxTags} reached` : placeholder}
        disabled={tags.length >= maxTags}
        className="w-full bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 outline-none"
      />
    </div>
  );
}

interface TimeEstimateProps {
  minutes: number;
}

export function TimeEstimate({ minutes }: TimeEstimateProps) {
  return (
    <div className="flex items-center gap-2 text-sm text-zinc-400">
      <Clock className="h-4 w-4" />
      <span>Estimated time: ~{minutes} min</span>
    </div>
  );
}
