#-------------------------------------------------------------------------------
# Name:        module1
# Purpose:
#
# Author:      schellenbergd
#
# Created:     16/04/2013
# Copyright:   (c) schellenbergd 2013
# Licence:     <your licence>
#-------------------------------------------------------------------------------
#!/usr/bin/env python

import turtle

wn = turtle.Screen()
wn.bgcolor("purple")

homer = turtle.Turtle()
homer.color("red")
homer.pensize(4)

color_list = ["green", "red", "blue", "yellow", "black", "pink", "magenta"]
for the_color in color_list:
    homer.color(the_color)
    homer.forward(100)
    homer.right(360/len(color_list))

wn.exitonclick()