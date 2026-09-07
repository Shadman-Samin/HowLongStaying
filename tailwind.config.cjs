/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,html}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"Share Tech Mono"', 'monospace'],
        display: ['Orbitron', 'sans-serif'],
        body: ['"Exo 2"', 'sans-serif']
      },
      animation: {
        pulseDot: 'pulseDot 1.2s ease-in-out infinite',
        float: 'float 4s ease-in-out infinite'
      },
      keyframes: {
        pulseDot: {
          '0%,100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.6', transform: 'scale(0.85)' }
        },
        float: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' }
        }
      }
    }
  },
  plugins: []
}
