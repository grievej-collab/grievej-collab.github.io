#-------------------------------------------------------------------------------
# Name:        Number Guessing Game
# Purpose:     To guess numbers.
#
# Author:      schellenbergd
#
# Created:     15/04/2013
# Copyright:   (c) schellenbergd 2013
# Licence:     <your licence>
#-------------------------------------------------------------------------------
#!/usr/bin/env python

import random

max_number = 100
number = random.randint(1,max_number)
number_of_guesses = 0
guess = -1  #initializing guess

name = input("Hello! What is your name?")
print("Well",name,"I'm thinking of a number between 1 and", max_number, ".")

while (guess != number):
    guess = input("Take a guess.")
    guess = int(guess)  #turning guess from a str to an int
    number_of_guesses = number_of_guesses + 1

    if (guess > number):
        print("Your guess is too high.")
    elif (guess < number):
        print("Your guess is too low.")
    else:
        print("Good job, ", name, "! You guessed my number in ", number_of_guesses, " guesses.",sep="")

