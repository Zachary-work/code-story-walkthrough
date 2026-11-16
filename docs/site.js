// Adds a "Copy" button to each code block that has a header.
for (const block of document.querySelectorAll('.code')) {
  const head = block.querySelector('.code-head');
  const pre = block.querySelector('pre');
  if (!head || !pre || !navigator.clipboard) {
    continue;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy';
  button.textContent = 'Copy';
  button.addEventListener('click', () => {
    navigator.clipboard.writeText(pre.textContent.trim()).then(() => {
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    }, () => {});
  });
  head.appendChild(button);
}
